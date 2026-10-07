import express from "express";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActivityType
} from "discord.js";

// =========================================================
// ENVIRONMENT VARIABLES
// =========================================================

const required = [
  "DISCORD_TOKEN",
  "GUILD_ID",
  "ROLE_ID",
  "WEBHOOK_SECRET",
  "APPLICATION_CHANNEL_ID",
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "BOT_OWNER_ID"
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Chýba premenná: ${name}`);
  }
}

// =========================================================
// SUPABASE
// =========================================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// =========================================================
// EXPRESS
// =========================================================

const app = express();

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "50kb"
  })
);

const port = Number(
  process.env.PORT || 3000
);

// =========================================================
// DISCORD CLIENT
// =========================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

// =========================================================
// SECURITY
// =========================================================

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

function authorized(req, res) {
  const auth = req.get("authorization") || "";

  const suppliedSecret = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";

  if (
    !safeEqual(
      suppliedSecret,
      process.env.WEBHOOK_SECRET
    )
  ) {
    res.status(401).json({
      error: "Unauthorized"
    });

    return false;
  }

  return true;
}

// =========================================================
// ECONOMY HELPERS
// =========================================================

const OWNER_ID = process.env.BOT_OWNER_ID;

async function getUser(discordId, username = "Unknown") {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (error) {
    console.error("Supabase getUser error:", error);
    throw new Error("Database error");
  }

  if (data) {
    if (data.username !== username) {
      await supabase
        .from("users")
        .update({
          username,
          updated_at: new Date().toISOString()
        })
        .eq("discord_id", discordId);
    }

    return {
      ...data,
      username
    };
  }

  const { data: created, error: insertError } =
    await supabase
      .from("users")
      .insert({
        discord_id: discordId,
        username,
        points: 0,
        blacklisted: false
      })
      .select()
      .single();

  if (insertError) {
    const { data: existing } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", discordId)
      .maybeSingle();

    if (existing) {
      return existing;
    }

    console.error(
      "Supabase create user error:",
      insertError
    );

    throw new Error("Database error");
  }

  return created;
}

async function isBotAdmin(discordId) {
  if (discordId === OWNER_ID) {
    return true;
  }

  const { data, error } = await supabase
    .from("bot_admins")
    .select("discord_id")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (error) {
    console.error("Supabase admin check error:", error);
    throw new Error("Database error");
  }

  return Boolean(data);
}

async function requireEconomyAdmin(interaction) {
  return isBotAdmin(interaction.user.id);
}

async function logTransaction(
  discordId,
  amount,
  type,
  performedBy = null
) {
  const { error } = await supabase
    .from("point_transactions")
    .insert({
      discord_id: discordId,
      amount,
      type,
      performed_by: performedBy
    });

  if (error) {
    console.error(
      "Supabase transaction log error:",
      error
    );
  }
}

async function setPoints(
  discordId,
  username,
  newPoints,
  type,
  performedBy = null
) {
  const user = await getUser(
    discordId,
    username
  );

  const oldPoints = Number(user.points || 0);

  const safePoints = Math.max(
    0,
    Math.floor(Number(newPoints))
  );

  const { data, error } = await supabase
    .from("users")
    .update({
      points: safePoints,
      username,
      updated_at: new Date().toISOString()
    })
    .eq("discord_id", discordId)
    .select()
    .single();

  if (error) {
    console.error(
      "Supabase setPoints error:",
      error
    );

    throw new Error("Database error");
  }

  await logTransaction(
    discordId,
    safePoints - oldPoints,
    type,
    performedBy
  );

  return data;
}

async function changePoints(
  discordId,
  username,
  amount,
  type,
  performedBy = null
) {
  const user = await getUser(
    discordId,
    username
  );

  const oldPoints = Number(user.points || 0);
  const newPoints = oldPoints + Number(amount);

  if (newPoints < 0) {
    throw new Error("INSUFFICIENT_POINTS");
  }

  return setPoints(
    discordId,
    username,
    newPoints,
    type,
    performedBy
  );
}

function formatPoints(points) {
  return Number(points || 0).toLocaleString("sk-SK");
}

function randomInt(min, max) {
  return Math.floor(
    Math.random() * (max - min + 1)
  ) + min;
}

async function ensureNotBlacklisted(
  interaction
) {
  const user = await getUser(
    interaction.user.id,
    interaction.user.tag
  );

  if (user.blacklisted) {
    await interaction.reply({
      content:
        "🚫 **Tvoj účet je blacklistovaný.** Nemôžeš používať economy príkazy.",
      ephemeral: true
    });

    return null;
  }

  return user;
}

// =========================================================
// HEALTH CHECK
// =========================================================

app.get("/", (_req, res) => {
  res.status(200).send(
    "Streamers Clash bot is running."
  );
});

// =========================================================
// SUBMIT APPLICATION
// =========================================================

app.post(
  "/submit-application",
  async (req, res) => {

    if (!authorized(req, res)) return;

    if (!client.isReady()) {
      return res.status(503).json({
        error: "Bot is not ready"
      });
    }

    const answers = req.body?.answers;

    if (
      !answers ||
      typeof answers !== "object" ||
      Array.isArray(answers)
    ) {
      return res.status(400).json({
        error: "Invalid answers"
      });
    }

    const entries = Object.entries(
      answers
    );

    if (entries.length === 0) {
      return res.status(400).json({
        error: "Application contains no answers"
      });
    }

    if (entries.length > 25) {
      return res.status(400).json({
        error:
          "Application contains more than 25 questions"
      });
    }

    const fields = entries.map(
      ([question, answer]) => ({
        name:
          String(question)
            .slice(0, 256) ||
          "Otázka",

        value:
          String(
            answer ?? "Bez odpovede"
          ).slice(0, 1024) ||
          "Bez odpovede",

        inline: false
      })
    );

    const totalLength =
      fields.reduce(
        (sum, field) =>
          sum +
          field.name.length +
          field.value.length,
        0
      );

    if (totalLength > 5500) {
      return res.status(400).json({
        error:
          "Application is too long for one Discord message"
      });
    }

    try {
      const channel =
        await client.channels.fetch(
          process.env.APPLICATION_CHANNEL_ID
        );

      if (
        !channel ||
        !channel.isTextBased() ||
        !channel.send
      ) {
        return res.status(500).json({
          error:
            "Application channel was not found"
        });
      }

      const embed =
        new EmbedBuilder()
          .setTitle(
            "📩 Nová náborová prihláška"
          )
          .setColor(0x5865F2)
          .addFields(fields)
          .setFooter({
            text:
              "Streamers Clash | Nábor"
          })
          .setTimestamp();

      const message =
        await channel.send({
          embeds: [embed],

          allowedMentions: {
            parse: []
          }
        });

      console.log(
        `PRIHLÁŠKA ODOSLANÁ | ${message.id}`
      );

      return res.status(200).json({
        ok: true,
        messageId: message.id
      });

    } catch (error) {
      console.error(
        "Odoslanie prihlášky zlyhalo:",
        error.code ||
        error.message
      );

      return res.status(500).json({
        error:
          "Nepodarilo sa odoslať prihlášku do Discordu"
      });
    }
  }
);

// =========================================================
// ASSIGN ROLE
// =========================================================

app.post(
  "/assign-role",
  async (req, res) => {

    if (!authorized(req, res)) return;

    const discordId =
      String(
        req.body?.discordId ?? ""
      ).trim();

    if (
      !/^\d{17,20}$/.test(
        discordId
      )
    ) {
      return res.status(400).json({
        error:
          "Invalid Discord ID"
      });
    }

    if (!client.isReady()) {
      return res.status(503).json({
        error:
          "Bot is not ready"
      });
    }

    try {
      const guild =
        await client.guilds.fetch(
          process.env.GUILD_ID
        );

      const role =
        await guild.roles.fetch(
          process.env.ROLE_ID
        );

      if (!role) {
        return res.status(500).json({
          error:
            "Configured role was not found"
        });
      }

      const member =
        await guild.members.fetch({
          user: discordId,
          force: true
        });

      if (
        member.roles.cache.has(
          role.id
        )
      ) {
        return res.status(200).json({
          ok: true,
          status:
            "already_has_role"
        });
      }

      await member.roles.add(
        role,
        "Automatická prihláška cez Google Forms"
      );

      console.log(
        `ROLE ASSIGNED | ${discordId}`
      );

      return res.status(200).json({
        ok: true,
        status:
          "role_assigned"
      });

    } catch (error) {
      console.error(
        "Role assignment failed:",
        error.code ||
        error.message
      );

      if (
        error.code === 10007
      ) {
        return res.status(404).json({
          error:
            "Member is not in the server"
        });
      }

      return res.status(500).json({
        error:
          "Role assignment failed"
      });
    }
  }
);
// =========================================================
// COMMANDS
// =========================================================

const pmRoleCommand =
  new SlashCommandBuilder()
    .setName("pm-role")
    .setDescription(
      "Pošle súkromnú správu všetkým členom s vybranou rolou."
    )
    .addRoleOption(
      option =>
        option
          .setName("role")
          .setDescription(
            "Rola, ktorej členom sa má poslať správa"
          )
          .setRequired(true)
    )
    .addStringOption(
      option =>
        option
          .setName("sprava")
          .setDescription(
            "Správa, ktorú má bot poslať"
          )
          .setRequired(true)
          .setMaxLength(2000)
    )
    .setDefaultMemberPermissions(
      PermissionsBitField.Flags.Administrator
    );

const balanceCommand =
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription(
      "Zobrazí stav tvojich bodov."
    );

const flipCommand =
  new SlashCommandBuilder()
    .setName("flip")
    .setDescription(
      "50/50 hra o virtuálne body."
    )
    .addIntegerOption(
      option =>
        option
          .setName("suma")
          .setDescription(
            "Počet bodov, ktoré chceš riskovať."
          )
          .setRequired(true)
          .setMinValue(1)
    );

const dailyCommand =
  new SlashCommandBuilder()
    .setName("daily")
    .setDescription(
      "Vyzdvihneš svoj denný bonus."
    );

const leaderboardCommand =
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription(
      "Zobrazí leaderboard bodov."
    );

const addPointsCommand =
  new SlashCommandBuilder()
    .setName("addpoints")
    .setDescription(
      "Pridá používateľovi body."
    )
    .addUserOption(
      option =>
        option
          .setName("user")
          .setDescription(
            "Používateľ"
          )
          .setRequired(true)
    )
    .addIntegerOption(
      option =>
        option
          .setName("suma")
          .setDescription(
            "Počet bodov"
          )
          .setRequired(true)
          .setMinValue(1)
    );

const removePointsCommand =
  new SlashCommandBuilder()
    .setName("removepoints")
    .setDescription(
      "Odoberie používateľovi body."
    )
    .addUserOption(
      option =>
        option
          .setName("user")
          .setDescription(
            "Používateľ"
          )
          .setRequired(true)
    )
    .addIntegerOption(
      option =>
        option
          .setName("suma")
          .setDescription(
            "Počet bodov"
          )
          .setRequired(true)
          .setMinValue(1)
    );

const setPointsCommand =
  new SlashCommandBuilder()
    .setName("setpoints")
    .setDescription(
      "Nastaví používateľovi presný počet bodov."
    )
    .addUserOption(
      option =>
        option
          .setName("user")
          .setDescription(
            "Používateľ"
          )
          .setRequired(true)
    )
    .addIntegerOption(
      option =>
        option
          .setName("suma")
          .setDescription(
            "Nový počet bodov"
          )
          .setRequired(true)
          .setMinValue(0)
    );

const resetPointsCommand =
  new SlashCommandBuilder()
    .setName("resetpoints")
    .setDescription(
      "Vynuluje používateľovi body."
    )
    .addUserOption(
      option =>
        option
          .setName("user")
          .setDescription(
            "Používateľ"
          )
          .setRequired(true)
    );

const blacklistCommand =
  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription(
      "Zablokuje používateľovi economy systém."
    )
    .addUserOption(
      option =>
        option
          .setName("user")
          .setDescription(
            "Používateľ"
          )
          .setRequired(true)
    );

const unblacklistCommand =
  new SlashCommandBuilder()
    .setName("unblacklist")
    .setDescription(
      "Odblokuje používateľovi economy systém."
    )
    .addUserOption(
      option =>
        option
          .setName("user")
          .setDescription(
            "Používateľ"
          )
          .setRequired(true)
    );

const addAdminCommand =
  new SlashCommandBuilder()
    .setName("addadmin")
    .setDescription(
      "Pridá používateľa medzi SGooBot adminov."
    )
    .addUserOption(
      option =>
        option
          .setName("user")
          .setDescription(
            "Používateľ"
          )
          .setRequired(true)
    );

const removeAdminCommand =
  new SlashCommandBuilder()
    .setName("removeadmin")
    .setDescription(
      "Odoberie používateľa zo SGooBot adminov."
    )
    .addUserOption(
      option =>
        option
          .setName("user")
          .setDescription(
            "Používateľ"
          )
          .setRequired(true)
    );

// =========================================================
// REGISTER SLASH COMMANDS
// =========================================================

const commands = [
  pmRoleCommand,
  balanceCommand,
  flipCommand,
  dailyCommand,
  leaderboardCommand,
  addPointsCommand,
  removePointsCommand,
  setPointsCommand,
  resetPointsCommand,
  blacklistCommand,
  unblacklistCommand,
  addAdminCommand,
  removeAdminCommand
];

async function registerCommands() {
  try {
    const rest =
      new REST({
        version: "10"
      }).setToken(
        process.env.DISCORD_TOKEN
      );

    await rest.put(
      Routes.applicationGuildCommands(
        client.user.id,
        process.env.GUILD_ID
      ),
      {
        body: commands.map(
          command => command.toJSON()
        )
      }
    );

    console.log(
      "Slash commands zaregistrované."
    );

  } catch (error) {
    console.error(
      "Registrácia slash commandov zlyhala:",
      error
    );
  }
}

// =========================================================
// PM ROLE
// =========================================================

async function handlePmRole(interaction) {
  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return interaction.reply({
      content:
        "❌ Tento príkaz môže používať iba administrátor.",
      ephemeral: true
    });
  }

  const role =
    interaction.options.getRole(
      "role",
      true
    );

  const message =
    interaction.options.getString(
      "sprava",
      true
    );

  await interaction.deferReply({
    ephemeral: true
  });

  try {
    const guild =
      interaction.guild;

    if (!guild) {
      return interaction.editReply(
        "❌ Tento príkaz je možné použiť iba na serveri."
      );
    }

    const members =
      await guild.members.fetch();

    const roleMembers =
      members.filter(
        member =>
          member.roles.cache.has(
            role.id
          ) &&
          !member.user.bot
      );

    if (
      roleMembers.size === 0
    ) {
      return interaction.editReply(
        `❌ Na serveri som nenašiel žiadnych členov s rolou ${role}.`
      );
    }

    let sent = 0;
    const failed = [];

    for (
      const member
      of roleMembers.values()
    ) {
      try {
        await member.send({
          content: message
        });

        sent++;

        console.log(
          `DM ODOSLANÉ | ${member.user.tag}`
        );

      } catch (error) {
        let reason =
          "Neznáma chyba";

        if (
          error.code === 50007
        ) {
          reason =
            "Používateľ nemôže prijímať DM od bota";
        } else if (
          error.code === 50278
        ) {
          reason =
            "Discord nedovolil DM tomuto používateľovi (50278)";
        } else if (
          error.code
        ) {
          reason =
            `Discord chyba ${error.code}`;
        } else if (
          error.message
        ) {
          reason =
            error.message;
        }

        failed.push({
          name:
            member.user.tag,
          id:
            member.user.id,
          reason
        });

        console.log(
          `DM NEODOSLANÉ | ${member.user.tag} | ${reason}`
        );
      }

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            1000
          )
      );
    }

    const result = [
      "📨 **Hromadná PM dokončená.**",
      "",
      `👥 Rola: ${role}`,
      `📨 Odoslané: **${sent}**`,
      `❌ Neodoslané: **${failed.length}**`,
      `👥 Celkom: **${roleMembers.size}**`
    ];

    if (
      failed.length > 0
    ) {
      result.push(
        "",
        "**❌ Neodoslané správy:**"
      );

      for (
        const user
        of failed
      ) {
        result.push(
          `• \`${user.name}\` — ${user.reason}`
        );
      }
    }

    await interaction.editReply(
      result.join("\n")
    );

  } catch (error) {
    console.error(
      "PM role command failed:",
      error
    );

    await interaction.editReply(
      "❌ Pri odosielaní PM správ nastala chyba."
    );
  }
}

// =========================================================
// ECONOMY: BALANCE
// =========================================================

async function handleBalance(interaction) {
  const user = await getUser(
    interaction.user.id,
    interaction.user.tag
  );

  const blacklistText =
    user.blacklisted
      ? "\n🚫 **Blacklist:** Áno"
      : "";

  return interaction.reply({
    content:
      `💰 **${interaction.user.username}**\n` +
      `Máš **${formatPoints(user.points)} bodov**.` +
      blacklistText,
    ephemeral: true
  });
}

// =========================================================
// ECONOMY: FLIP
// =========================================================

async function handleFlip(interaction) {
  const user =
    await ensureNotBlacklisted(
      interaction
    );

  if (!user) return;

  const amount =
    interaction.options.getInteger(
      "suma",
      true
    );

  const currentPoints =
    Number(user.points || 0);

  if (amount > currentPoints) {
    return interaction.reply({
      content:
        `❌ Nemáš dostatok bodov.\n` +
        `Máš **${formatPoints(currentPoints)}**, ` +
        `ale potrebuješ **${formatPoints(amount)}**.`,
      ephemeral: true
    });
  }

  const won =
    Math.random() < 0.5;

  const change =
    won ? amount : -amount;

  const updated =
    await changePoints(
      interaction.user.id,
      interaction.user.tag,
      change,
      won ? "flip_win" : "flip_loss",
      interaction.user.id
    );

  if (won) {
    return interaction.reply(
      `🪙 **VYHRAL SI!**\n\n` +
      `🎉 +**${formatPoints(amount)}** bodov\n` +
      `💰 Nový zostatok: **${formatPoints(updated.points)}**`
    );
  }

  return interaction.reply(
    `🪙 **PREHRAL SI!**\n\n` +
    `💀 -**${formatPoints(amount)}** bodov\n` +
    `💰 Nový zostatok: **${formatPoints(updated.points)}**`
  );
}

// =========================================================
// ECONOMY: DAILY
// =========================================================

async function handleDaily(interaction) {
  const user =
    await ensureNotBlacklisted(
      interaction
    );

  if (!user) return;

  const now =
    new Date();

  if (user.last_daily) {
    const last =
      new Date(user.last_daily);

    const elapsed =
      now.getTime() -
      last.getTime();

    const cooldown =
      24 * 60 * 60 * 1000;

    if (elapsed < cooldown) {
      const remaining =
        cooldown - elapsed;

      const hours =
        Math.floor(
          remaining /
          (60 * 60 * 1000)
        );

      const minutes =
        Math.floor(
          (remaining %
            (60 * 60 * 1000)) /
          (60 * 1000)
        );

      return interaction.reply({
        content:
          `⏳ Denný bonus si už vyzdvihol.\n` +
          `Skús znova približne o **${hours}h ${minutes}m**.`,
        ephemeral: true
      });
    }
  }

  const reward =
    randomInt(100, 500);

  const updated =
    await changePoints(
      interaction.user.id,
      interaction.user.tag,
      reward,
      "daily",
      interaction.user.id
    );

  const { error } =
    await supabase
      .from("users")
      .update({
        last_daily:
          now.toISOString(),
        updated_at:
          now.toISOString()
      })
      .eq(
        "discord_id",
        interaction.user.id
      );

  if (error) {
    console.error(
      "Supabase daily update error:",
      error
    );
  }

  return interaction.reply(
    `🎁 **Denný bonus!**\n\n` +
    `💰 Získal si **${formatPoints(reward)}** bodov.\n` +
    `💳 Zostatok: **${formatPoints(updated.points)}**`
  );
}

// =========================================================
// ECONOMY: LEADERBOARD
// =========================================================

async function handleLeaderboard(interaction) {
  const { data, error } =
    await supabase
      .from("users")
      .select(
        "discord_id, username, points"
      )
      .eq("blacklisted", false)
      .order("points", {
        ascending: false
      })
      .limit(10);

  if (error) {
    console.error(
      "Supabase leaderboard error:",
      error
    );

    return interaction.reply({
      content:
        "❌ Nepodarilo sa načítať leaderboard.",
      ephemeral: true
    });
  }

  if (!data || data.length === 0) {
    return interaction.reply(
      "🏆 Leaderboard je zatiaľ prázdny."
    );
  }

  const medals = [
    "🥇",
    "🥈",
    "🥉"
  ];

  const lines =
    data.map(
      (user, index) => {
        const prefix =
          medals[index] ||
          `**${index + 1}.**`;

        return (
          `${prefix} <@${user.discord_id}> — ` +
          `**${formatPoints(user.points)}** bodov`
        );
      }
    );

  return interaction.reply({
    content:
      "🏆 **SGooBot LEADERBOARD**\n\n" +
      lines.join("\n")
  });
}
// =========================================================
// ADMIN: ADD POINTS
// =========================================================

async function handleAddPoints(interaction) {
  if (
    !(await requireEconomyAdmin(
      interaction
    ))
  ) {
    return interaction.reply({
      content:
        "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target =
    interaction.options.getUser(
      "user",
      true
    );

  const amount =
    interaction.options.getInteger(
      "suma",
      true
    );

  const updated =
    await changePoints(
      target.id,
      target.tag,
      amount,
      "admin_add",
      interaction.user.id
    );

  return interaction.reply(
    `✅ <@${target.id}> bolo pridaných **${formatPoints(amount)}** bodov.\n` +
    `💰 Nový zostatok: **${formatPoints(updated.points)}**`
  );
}

// =========================================================
// ADMIN: REMOVE POINTS
// =========================================================

async function handleRemovePoints(interaction) {
  if (
    !(await requireEconomyAdmin(
      interaction
    ))
  ) {
    return interaction.reply({
      content:
        "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target =
    interaction.options.getUser(
      "user",
      true
    );

  const amount =
    interaction.options.getInteger(
      "suma",
      true
    );

  const user =
    await getUser(
      target.id,
      target.tag
    );

  const current =
    Number(user.points || 0);

  if (amount > current) {
    return interaction.reply({
      content:
        `❌ Používateľ má iba **${formatPoints(current)}** bodov.`,
      ephemeral: true
    });
  }

  const updated =
    await changePoints(
      target.id,
      target.tag,
      -amount,
      "admin_remove",
      interaction.user.id
    );

  return interaction.reply(
    `✅ <@${target.id}> bolo odobraných **${formatPoints(amount)}** bodov.\n` +
    `💰 Nový zostatok: **${formatPoints(updated.points)}**`
  );
}

// =========================================================
// ADMIN: SET POINTS
// =========================================================

async function handleSetPoints(interaction) {
  if (
    !(await requireEconomyAdmin(
      interaction
    ))
  ) {
    return interaction.reply({
      content:
        "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target =
    interaction.options.getUser(
      "user",
      true
    );

  const amount =
    interaction.options.getInteger(
      "suma",
      true
    );

  const updated =
    await setPoints(
      target.id,
      target.tag,
      amount,
      "admin_set",
      interaction.user.id
    );

  return interaction.reply(
    `✅ <@${target.id}> má teraz **${formatPoints(updated.points)}** bodov.`
  );
}

// =========================================================
// ADMIN: RESET POINTS
// =========================================================

async function handleResetPoints(interaction) {
  if (
    !(await requireEconomyAdmin(
      interaction
    ))
  ) {
    return interaction.reply({
      content:
        "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target =
    interaction.options.getUser(
      "user",
      true
    );

  const updated =
    await setPoints(
      target.id,
      target.tag,
      0,
      "admin_reset",
      interaction.user.id
    );

  return interaction.reply(
    `♻️ Body používateľa <@${target.id}> boli vynulované.`
  );
}

// =========================================================
// ADMIN: BLACKLIST
// =========================================================

async function handleBlacklist(interaction) {
  if (
    !(await requireEconomyAdmin(
      interaction
    ))
  ) {
    return interaction.reply({
      content:
        "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target =
    interaction.options.getUser(
      "user",
      true
    );

  if (
    target.id === OWNER_ID
  ) {
    return interaction.reply({
      content:
        "❌ Ownera nie je možné blacklistovať.",
      ephemeral: true
    });
  }

  const user =
    await getUser(
      target.id,
      target.tag
    );

  if (user.blacklisted) {
    return interaction.reply({
      content:
        "⚠️ Tento používateľ už je blacklistovaný.",
      ephemeral: true
    });
  }

  const { error } =
    await supabase
      .from("users")
      .update({
        blacklisted: true,
        updated_at:
          new Date().toISOString()
      })
      .eq(
        "discord_id",
        target.id
      );

  if (error) {
    console.error(
      "Supabase blacklist error:",
      error
    );

    return interaction.reply({
      content:
        "❌ Nepodarilo sa nastaviť blacklist.",
      ephemeral: true
    });
  }

  await logTransaction(
    target.id,
    0,
    "blacklist",
    interaction.user.id
  );

  return interaction.reply(
    `🚫 <@${target.id}> bol blacklistovaný z economy systému.`
  );
}

// =========================================================
// ADMIN: UNBLACKLIST
// =========================================================

async function handleUnblacklist(interaction) {
  if (
    !(await requireEconomyAdmin(
      interaction
    ))
  ) {
    return interaction.reply({
      content:
        "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target =
    interaction.options.getUser(
      "user",
      true
    );

  const user =
    await getUser(
      target.id,
      target.tag
    );

  if (!user.blacklisted) {
    return interaction.reply({
      content:
        "⚠️ Tento používateľ nie je blacklistovaný.",
      ephemeral: true
    });
  }

  const { error } =
    await supabase
      .from("users")
      .update({
        blacklisted: false,
        updated_at:
          new Date().toISOString()
      })
      .eq(
        "discord_id",
        target.id
      );

  if (error) {
    console.error(
      "Supabase unblacklist error:",
      error
    );

    return interaction.reply({
      content:
        "❌ Nepodarilo sa zrušiť blacklist.",
      ephemeral: true
    });
  }

  await logTransaction(
    target.id,
    0,
    "unblacklist",
    interaction.user.id
  );

  return interaction.reply(
    `✅ <@${target.id}> už nie je blacklistovaný.`
  );
}

// =========================================================
// OWNER: ADD ADMIN
// =========================================================

async function handleAddAdmin(interaction) {
  if (
    interaction.user.id !== OWNER_ID
  ) {
    return interaction.reply({
      content:
        "❌ Tento príkaz môže používať iba owner SGooBotu.",
      ephemeral: true
    });
  }

  const target =
    interaction.options.getUser(
      "user",
      true
    );

  if (
    target.id === OWNER_ID
  ) {
    return interaction.reply({
      content:
        "ℹ️ Ty už máš najvyššie oprávnenie.",
      ephemeral: true
    });
  }

  const { data: existing, error: checkError } =
    await supabase
      .from("bot_admins")
      .select("discord_id")
      .eq(
        "discord_id",
        target.id
      )
      .maybeSingle();

  if (checkError) {
    console.error(
      "Supabase add admin check error:",
      checkError
    );

    return interaction.reply({
      content:
        "❌ Nepodarilo sa skontrolovať admina.",
      ephemeral: true
    });
  }

  if (existing) {
    return interaction.reply({
      content:
        "⚠️ Tento používateľ už je bot admin.",
      ephemeral: true
    });
  }

  const { error } =
    await supabase
      .from("bot_admins")
      .insert({
        discord_id:
          target.id,
        added_by:
          interaction.user.id
      });

  if (error) {
    console.error(
      "Supabase add admin error:",
      error
    );

    return interaction.reply({
      content:
        "❌ Nepodarilo sa pridať admina.",
      ephemeral: true
    });
  }

  return interaction.reply(
    `👑 <@${target.id}> bol pridaný medzi **SGooBot adminov**.`
  );
}

// =========================================================
// OWNER: REMOVE ADMIN
// =========================================================

async function handleRemoveAdmin(interaction) {
  if (
    interaction.user.id !== OWNER_ID
  ) {
    return interaction.reply({
      content:
        "❌ Tento príkaz môže používať iba owner SGooBotu.",
      ephemeral: true
    });
  }

  const target =
    interaction.options.getUser(
      "user",
      true
    );

  if (
    target.id === OWNER_ID
  ) {
    return interaction.reply({
      content:
        "❌ Ownera nie je možné odobrať z owner oprávnení.",
      ephemeral: true
    });
  }

  const { error } =
    await supabase
      .from("bot_admins")
      .delete()
      .eq(
        "discord_id",
        target.id
      );

  if (error) {
    console.error(
      "Supabase remove admin error:",
      error
    );

    return interaction.reply({
      content:
        "❌ Nepodarilo sa odobrať admina.",
      ephemeral: true
    });
  }

  return interaction.reply(
    `✅ <@${target.id}> bol odobraný zo **SGooBot adminov**.`
  );
}
// =========================================================
// INTERACTION HANDLER
// =========================================================

client.on(
  "interactionCreate",
  async interaction => {

    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    try {
      switch (
        interaction.commandName
      ) {
        case "pm-role":
          return handlePmRole(
            interaction
          );

        case "balance":
          return handleBalance(
            interaction
          );

        case "flip":
          return handleFlip(
            interaction
          );

        case "daily":
          return handleDaily(
            interaction
          );

        case "leaderboard":
          return handleLeaderboard(
            interaction
          );

        case "addpoints":
          return handleAddPoints(
            interaction
          );

        case "removepoints":
          return handleRemovePoints(
            interaction
          );

        case "setpoints":
          return handleSetPoints(
            interaction
          );

        case "resetpoints":
          return handleResetPoints(
            interaction
          );

        case "blacklist":
          return handleBlacklist(
            interaction
          );

        case "unblacklist":
          return handleUnblacklist(
            interaction
          );

        case "addadmin":
          return handleAddAdmin(
            interaction
          );

        case "removeadmin":
          return handleRemoveAdmin(
            interaction
          );

        default:
          return;
      }

    } catch (error) {
      console.error(
        `Command ${interaction.commandName} failed:`,
        error
      );

      const message =
        "❌ Pri vykonávaní príkazu nastala chyba.";

      if (
        interaction.replied ||
        interaction.deferred
      ) {
        await interaction.editReply(
          message
        ).catch(() => {});
      } else {
        await interaction.reply({
          content: message,
          ephemeral: true
        }).catch(() => {});
      }
    }
  }
);

// =========================================================
// BOT READY
// =========================================================

client.once(
  "clientReady",
  async readyClient => {

    console.log(
      `Logged in as ${readyClient.user.tag}`
    );

    readyClient.user.setActivity(
      "twitch.tv/sgooob",
      {
        type: ActivityType.Streaming,
        url: "https://www.twitch.tv/sgooob"
      }
    );

    await registerCommands();
  }
);

// =========================================================
// LOGIN
// =========================================================

client.login(
  process.env.DISCORD_TOKEN
);

// =========================================================
// HTTP SERVER
// =========================================================

app.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `HTTP server listening on port ${port}`
    );
  }
);
