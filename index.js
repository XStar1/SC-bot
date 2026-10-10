
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
  ActivityType,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder
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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    ...(process.env.ENABLE_PRESENCE_INTENT === "true" ? [GatewayIntentBits.GuildPresences] : [])
  ]
});

// =========================================================
// CENTRAL DISCORD LOGGING
// =========================================================

async function auditLog(title, description, color = 0x5865F2) {
  const safeDescription = String(description || "Bez detailov").slice(0, 4000);
  console.log(`[AUDIT] ${title} | ${safeDescription}`);

  if (!process.env.LOG_CHANNEL_ID || !client.isReady()) return;

  try {
    const channel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
    if (!channel?.isTextBased() || typeof channel.send !== "function") return;

    const embed = new EmbedBuilder()
      .setTitle(String(title).slice(0, 256))
      .setDescription(safeDescription)
      .setColor(color)
      .setTimestamp();

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("Audit log sa nepodarilo odoslať:", error?.code || error?.message || error);
  }
}

// Tier hierarchy: 1 = economy, 2 = moderation, 3 = full admin, 4 = owner.
const COMMAND_TIERS = Object.freeze({
  addpoints: 1, removepoints: 1, setpoints: 1, resetpoints: 1,
  move: 2, clear: 2, slowmode: 2, roleinfo: 2, userinfo: 2,
  addrole: 3, removerole: 3, announce: 3, "pm-role": 3,
  blacklist: 3, unblacklist: 3,
  addadmin: 4, removeadmin: 4
});

async function getAdminTier(discordId) {
  if (discordId === OWNER_ID) return 4;
  const { data, error } = await supabase.from("bot_admins")
    .select("tier").eq("discord_id", discordId).maybeSingle();
  if (error) throw new Error(`Nepodarilo sa overiť tier: ${error.message}`);
  return data ? Number(data.tier) : 0;
}

async function requireTier(interaction, requiredTier) {
  const tier = await getAdminTier(interaction.user.id);
  if (tier >= requiredTier) return true;

  await auditLog(
    "⚠️ Zamietnutý príkaz",
    `Používateľ: ${interaction.user.tag} (${interaction.user.id})\nPríkaz: /${interaction.commandName}\nTier: ${tier} / požadovaný ${requiredTier}`,
    0xED4245
  );

  const reply = {
    content: `❌ Potrebuješ SGooBot Tier ${requiredTier}${requiredTier === 4 ? " (iba owner)" : ""}. Tvoj tier: ${tier}.`,
    ephemeral: true
  };

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(reply).catch(() => {});
  } else {
    await interaction.reply(reply).catch(() => {});
  }

  return false;
}

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
    console.warn(`Unauthorized API request | ${req.method} ${req.path}`);

    void auditLog(
      "⚠️ Neoprávnená API požiadavka",
      `Metóda: ${req.method}\nEndpoint: ${req.path}`,
      0xED4245
    );

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

async function requireEconomyAdmin(interaction) {
  return (await getAdminTier(interaction.user.id)) >= 1;
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

    const entries = Object.entries(answers);

    if (entries.length === 0) {
      return res.status(400).json({
        error: "Application contains no answers"
      });
    }

    if (entries.length > 25) {
      return res.status(400).json({
        error: "Application contains more than 25 questions"
      });
    }

    const fields = entries.map(
      ([question, answer]) => ({
        name:
          String(question).slice(0, 256) ||
          "Otázka",

        value:
          String(answer ?? "Bez odpovede").slice(0, 1024) ||
          "Bez odpovede",

        inline: false
      })
    );

    const totalLength = fields.reduce(
      (sum, field) =>
        sum + field.name.length + field.value.length,
      0
    );

    if (totalLength > 5500) {
      return res.status(400).json({
        error: "Application is too long for one Discord message"
      });
    }

    try {
      const channel = await client.channels.fetch(
        process.env.APPLICATION_CHANNEL_ID
      );

      if (
        !channel ||
        !channel.isTextBased() ||
        !channel.send
      ) {
        return res.status(500).json({
          error: "Application channel was not found"
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("📩 Nová náborová prihláška")
        .setColor(0x5865F2)
        .addFields(fields)
        .setFooter({
          text: "Streamers Clash | Nábor"
        })
        .setTimestamp();

      const message = await channel.send({
        embeds: [embed],
        allowedMentions: {
          parse: []
        }
      });

      console.log(
        `PRIHLÁŠKA ODOSLANÁ | ${message.id}`
      );

      await auditLog(
        "Nová náborová prihláška",
        `Správa: ${message.id}\nKanál: ${channel.id}`,
        0x57F287
      );

      return res.status(200).json({
        ok: true,
        messageId: message.id
      });

    } catch (error) {
      console.error(
        "Odoslanie prihlášky zlyhalo:",
        error.code || error.message
      );

      return res.status(500).json({
        error: "Nepodarilo sa odoslať prihlášku do Discordu"
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

    const discordId = String(
      req.body?.discordId ?? ""
    ).trim();

    if (!/^\d{17,20}$/.test(discordId)) {
      return res.status(400).json({
        error: "Invalid Discord ID"
      });
    }

    if (!client.isReady()) {
      return res.status(503).json({
        error: "Bot is not ready"
      });
    }

    try {
      const guild = await client.guilds.fetch(
        process.env.GUILD_ID
      );

      const role = await guild.roles.fetch(
        process.env.ROLE_ID
      );

      if (!role) {
        return res.status(500).json({
          error: "Configured role was not found"
        });
      }

      const member = await guild.members.fetch({
        user: discordId,
        force: true
      });

      if (member.roles.cache.has(role.id)) {
        return res.status(200).json({
          ok: true,
          status: "already_has_role"
        });
      }

      await member.roles.add(
        role,
        "Automatická prihláška cez Google Forms"
      );

      console.log(
        `ROLE ASSIGNED | ${discordId}`
      );

      await auditLog(
        "Náborová rola pridelená",
        `Používateľ ID: ${discordId}\nRola: ${role.name} (${role.id})`,
        0x57F287
      );

      return res.status(200).json({
        ok: true,
        status: "role_assigned"
      });

    } catch (error) {
      console.error(
        "Role assignment failed:",
        error.code || error.message
      );

      if (error.code === 10007) {
        return res.status(404).json({
          error: "Member is not in the server"
        });
      }

      return res.status(500).json({
        error: "Role assignment failed"
      });
    }
  }
);

// =========================================================
// COMMANDS
// =========================================================

const commandsCommand = new SlashCommandBuilder()
  .setName("commands")
  .setDescription("Zobrazí všetky príkazy SGooBotu.");

const addRoleCommand = new SlashCommandBuilder()
  .setName("addrole")
  .setDescription("Pridá používateľovi rolu.")
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  )
  .addRoleOption(o =>
    o.setName("role")
      .setDescription("Rola na pridanie")
      .setRequired(true)
  );

const removeRoleCommand = new SlashCommandBuilder()
  .setName("removerole")
  .setDescription("Odoberie používateľovi rolu.")
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  )
  .addRoleOption(o =>
    o.setName("role")
      .setDescription("Rola na odobratie")
      .setRequired(true)
  );

const moveCommand = new SlashCommandBuilder()
  .setName("move")
  .setDescription("Presunie používateľa do hlasového kanála.")
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Používateľ na presunutie")
      .setRequired(true)
  )
  .addChannelOption(o =>
    o.setName("to")
      .setDescription("Cieľový hlasový kanál")
      .addChannelTypes(
        ChannelType.GuildVoice,
        ChannelType.GuildStageVoice
      )
      .setRequired(true)
  )
  .addChannelOption(o =>
    o.setName("from")
      .setDescription("Odkiaľ ho presunúť (voliteľné)")
      .addChannelTypes(
        ChannelType.GuildVoice,
        ChannelType.GuildStageVoice
      )
      .setRequired(false)
  );

const clearCommand = new SlashCommandBuilder()
  .setName("clear")
  .setDescription("Vymaže posledné správy v tomto kanáli (1–100).")
  .addIntegerOption(o =>
    o.setName("amount")
      .setDescription("Počet správ, 1 až 100")
      .setMinValue(1)
      .setMaxValue(100)
      .setRequired(true)
  );

const slowmodeCommand = new SlashCommandBuilder()
  .setName("slowmode")
  .setDescription("Nastaví pomalý režim kanála; 0 ho vypne.")
  .addIntegerOption(o =>
    o.setName("seconds")
      .setDescription("Sekundy: 0 až 21600")
      .setMinValue(0)
      .setMaxValue(21600)
      .setRequired(true)
  );

const roleInfoCommand = new SlashCommandBuilder()
  .setName("roleinfo")
  .setDescription("Zobrazí informácie o role.")
  .addRoleOption(o =>
    o.setName("role")
      .setDescription("Rola na kontrolu")
      .setRequired(true)
  );

const userInfoCommand = new SlashCommandBuilder()
  .setName("userinfo")
  .setDescription("Zobrazí informácie o používateľovi na serveri.")
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  );

const announceCommand = new SlashCommandBuilder()
  .setName("announce")
  .setDescription("Odošle textové oznámenie s podporou zmienok.")
  .addChannelOption(o =>
    o.setName("channel")
      .setDescription("Kanál oznámenia")
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement
      )
      .setRequired(true)
  )
  .addStringOption(o =>
    o.setName("title")
      .setDescription("Nadpis oznámenia")
      .setMaxLength(256)
      .setRequired(true)
  )
  .addStringOption(o =>
    o.setName("text")
      .setDescription("Text oznámenia")
      .setMaxLength(1700)
      .setRequired(true)
  );

const pmRoleCommand = new SlashCommandBuilder()
  .setName("pm-role")
  .setDescription(
    "Pošle súkromnú správu všetkým členom s vybranou rolou."
  )
  .addRoleOption(option =>
    option
      .setName("role")
      .setDescription(
        "Rola, ktorej členom sa má poslať správa"
      )
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName("sprava")
      .setDescription("Správa, ktorú má bot poslať")
      .setRequired(true)
      .setMaxLength(2000)
  );

const balanceCommand = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("Zobrazí stav tvojich bodov.");

const flipCommand = new SlashCommandBuilder()
  .setName("flip")
  .setDescription("50/50 hra o virtuálne body.")
  .addIntegerOption(option =>
    option
      .setName("suma")
      .setDescription("Počet bodov, ktoré chceš riskovať.")
      .setRequired(true)
      .setMinValue(1)
  );

const dailyCommand = new SlashCommandBuilder()
  .setName("daily")
  .setDescription("Vyzdvihneš svoj denný bonus.");

const leaderboardCommand = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Zobrazí leaderboard bodov.");

const addPointsCommand = new SlashCommandBuilder()
  .setName("addpoints")
  .setDescription("Pridá používateľovi body.")
  .addUserOption(option =>
    option
      .setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option
      .setName("suma")
      .setDescription("Počet bodov")
      .setRequired(true)
      .setMinValue(1)
  );

const removePointsCommand = new SlashCommandBuilder()
  .setName("removepoints")
  .setDescription("Odoberie používateľovi body.")
  .addUserOption(option =>
    option
      .setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option
      .setName("suma")
      .setDescription("Počet bodov")
      .setRequired(true)
      .setMinValue(1)
  );

const setPointsCommand = new SlashCommandBuilder()
  .setName("setpoints")
  .setDescription("Nastaví používateľovi presný počet bodov.")
  .addUserOption(option =>
    option
      .setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option
      .setName("suma")
      .setDescription("Nový počet bodov")
      .setRequired(true)
      .setMinValue(0)
  );

const resetPointsCommand = new SlashCommandBuilder()
  .setName("resetpoints")
  .setDescription("Vynuluje používateľovi body.")
  .addUserOption(option =>
    option
      .setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  );

const blacklistCommand = new SlashCommandBuilder()
  .setName("blacklist")
  .setDescription("Zablokuje používateľovi economy systém.")
  .addUserOption(option =>
    option
      .setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  );

const unblacklistCommand = new SlashCommandBuilder()
  .setName("unblacklist")
  .setDescription("Odblokuje používateľovi economy systém.")
  .addUserOption(option =>
    option
      .setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  );

const addAdminCommand = new SlashCommandBuilder()
  .setName("addadmin")
  .setDescription("Pridá používateľa medzi SGooBot adminov.")
  .addUserOption(option =>
    option
      .setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option
      .setName("tier")
      .setDescription("Tier oprávnení (1, 2 alebo 3)")
      .setRequired(true)
      .addChoices(
        { name: "Tier 1 – Economy", value: 1 },
        { name: "Tier 2 – Moderátor", value: 2 },
        { name: "Tier 3 – Head Admin", value: 3 }
      )
  );

const removeAdminCommand = new SlashCommandBuilder()
  .setName("removeadmin")
  .setDescription("Odoberie používateľa zo SGooBot adminov.")
  .addUserOption(option =>
    option
      .setName("user")
      .setDescription("Používateľ")
      .setRequired(true)
  );

// =========================================================
// CUSTOM GAMES 5V5 - SLASH COMMAND
// =========================================================

const customCommand = new SlashCommandBuilder()
  .setName("custom")
  .setDescription("Správa custom 5v5 hier")
  .addSubcommand(subcommand =>
    subcommand
      .setName("create")
      .setDescription(
        "Vytvorí custom 5v5 z pevnej čakacej voice roomky"
      )
  );

// =========================================================
// REGISTER SLASH COMMANDS
// =========================================================

const commands = [
  commandsCommand,
  addRoleCommand,
  removeRoleCommand,
  moveCommand,
  clearCommand,
  slowmodeCommand,
  roleInfoCommand,
  userInfoCommand,
  announceCommand,
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
  removeAdminCommand,
  customCommand
];

async function registerCommands() {
  try {
    const rest = new REST({
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
  const role = interaction.options.getRole("role", true);
  const message = interaction.options.getString("sprava", true);

  await interaction.deferReply({ ephemeral: true });

  try {
    const guild = interaction.guild;

    if (!guild) {
      return interaction.editReply(
        "❌ Tento príkaz je možné použiť iba na serveri."
      );
    }

    const members = await guild.members.fetch();

    const roleMembers = members.filter(
      member =>
        member.roles.cache.has(role.id) &&
        !member.user.bot
    );

    if (roleMembers.size === 0) {
      return interaction.editReply(
        `❌ Na serveri som nenašiel žiadnych členov s rolou ${role}.`
      );
    }

    let sent = 0;
    const failed = [];

    for (const member of roleMembers.values()) {
      try {
        await member.send({ content: message });
        sent++;

        console.log(`DM ODOSLANÉ | ${member.user.tag}`);

      } catch (error) {
        let reason = "Neznáma chyba";

        if (error.code === 50007) {
          reason = "Používateľ nemôže prijímať DM od bota";
        } else if (error.code === 50278) {
          reason = "Discord nedovolil DM tomuto používateľovi (50278)";
        } else if (error.code) {
          reason = `Discord chyba ${error.code}`;
        } else if (error.message) {
          reason = error.message;
        }

        failed.push({
          name: member.user.tag,
          id: member.user.id,
          reason
        });

        console.log(
          `DM NEODOSLANÉ | ${member.user.tag} | ${reason}`
        );
      }

      await new Promise(resolve =>
        setTimeout(resolve, 1000)
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

    if (failed.length > 0) {
      result.push("", "**❌ Neodoslané správy:**");

      for (const user of failed) {
        result.push(
          `• \`${user.name}\` — ${user.reason}`
        );
      }
    }

    await interaction.editReply(result.join("\n"));

  } catch (error) {
    console.error("PM role command failed:", error);

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

  const blacklistText = user.blacklisted
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
  const user = await ensureNotBlacklisted(interaction);
  if (!user) return;

  const amount = interaction.options.getInteger(
    "suma",
    true
  );

  const currentPoints = Number(user.points || 0);

  if (amount > currentPoints) {
    return interaction.reply({
      content:
        `❌ Nemáš dostatok bodov.\n` +
        `Máš **${formatPoints(currentPoints)}**, ` +
        `ale potrebuješ **${formatPoints(amount)}**.`,
      ephemeral: true
    });
  }

  const won = Math.random() < 0.5;
  const change = won ? amount : -amount;

  const updated = await changePoints(
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
  const user = await ensureNotBlacklisted(interaction);
  if (!user) return;

  const now = new Date();

  if (user.last_daily) {
    const last = new Date(user.last_daily);

    const elapsed = now.getTime() - last.getTime();
    const cooldown = 24 * 60 * 60 * 1000;

    if (elapsed < cooldown) {
      const remaining = cooldown - elapsed;

      const hours = Math.floor(
        remaining / (60 * 60 * 1000)
      );

      const minutes = Math.floor(
        (remaining % (60 * 60 * 1000)) / (60 * 1000)
      );

      return interaction.reply({
        content:
          `⏳ Denný bonus si už vyzdvihol.\n` +
          `Skús znova približne o **${hours}h ${minutes}m**.`,
        ephemeral: true
      });
    }
  }

  const reward = randomInt(100, 500);

  const updated = await changePoints(
    interaction.user.id,
    interaction.user.tag,
    reward,
    "daily",
    interaction.user.id
  );

  const { error } = await supabase
    .from("users")
    .update({
      last_daily: now.toISOString(),
      updated_at: now.toISOString()
    })
    .eq("discord_id", interaction.user.id);

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
  const { data, error } = await supabase
    .from("users")
    .select("discord_id, username, points")
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
      content: "❌ Nepodarilo sa načítať leaderboard.",
      ephemeral: true
    });
  }

  if (!data || data.length === 0) {
    return interaction.reply(
      "🏆 Leaderboard je zatiaľ prázdny."
    );
  }

  const medals = ["🥇", "🥈", "🥉"];

  const lines = data.map((user, index) => {
    const prefix = medals[index] || `**${index + 1}.**`;

    return (
      `${prefix} <@${user.discord_id}> — ` +
      `**${formatPoints(user.points)}** bodov`
    );
  });

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
  if (!(await requireEconomyAdmin(interaction))) {
    return interaction.reply({
      content: "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("suma", true);

  const updated = await changePoints(
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
  if (!(await requireEconomyAdmin(interaction))) {
    return interaction.reply({
      content: "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("suma", true);

  const user = await getUser(target.id, target.tag);
  const current = Number(user.points || 0);

  if (amount > current) {
    return interaction.reply({
      content:
        `❌ Používateľ má iba **${formatPoints(current)}** bodov.`,
      ephemeral: true
    });
  }

  const updated = await changePoints(
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
  if (!(await requireEconomyAdmin(interaction))) {
    return interaction.reply({
      content: "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("suma", true);

  const updated = await setPoints(
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
  if (!(await requireEconomyAdmin(interaction))) {
    return interaction.reply({
      content: "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target = interaction.options.getUser("user", true);

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
  if (!(await requireEconomyAdmin(interaction))) {
    return interaction.reply({
      content: "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target = interaction.options.getUser("user", true);

  if (target.id === OWNER_ID) {
    return interaction.reply({
      content: "❌ Ownera nie je možné blacklistovať.",
      ephemeral: true
    });
  }

  const user = await getUser(target.id, target.tag);

  if (user.blacklisted) {
    return interaction.reply({
      content: "⚠️ Tento používateľ už je blacklistovaný.",
      ephemeral: true
    });
  }

  const { error } = await supabase
    .from("users")
    .update({
      blacklisted: true,
      updated_at: new Date().toISOString()
    })
    .eq("discord_id", target.id);

  if (error) {
    console.error("Supabase blacklist error:", error);

    return interaction.reply({
      content: "❌ Nepodarilo sa nastaviť blacklist.",
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
  if (!(await requireEconomyAdmin(interaction))) {
    return interaction.reply({
      content: "❌ Na tento príkaz nemáš oprávnenie.",
      ephemeral: true
    });
  }

  const target = interaction.options.getUser("user", true);
  const user = await getUser(target.id, target.tag);

  if (!user.blacklisted) {
    return interaction.reply({
      content: "⚠️ Tento používateľ nie je blacklistovaný.",
      ephemeral: true
    });
  }

  const { error } = await supabase
    .from("users")
    .update({
      blacklisted: false,
      updated_at: new Date().toISOString()
    })
    .eq("discord_id", target.id);

  if (error) {
    console.error("Supabase unblacklist error:", error);

    return interaction.reply({
      content: "❌ Nepodarilo sa zrušiť blacklist.",
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
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({
      content: "❌ Iba owner.",
      ephemeral: true
    });
  }

  const target = interaction.options.getUser("user", true);
  const tier = interaction.options.getInteger("tier", true);

  if (target.id === OWNER_ID) {
    return interaction.reply({
      content:
        "ℹ️ Owner má automaticky najvyššie oprávnenia.",
      ephemeral: true
    });
  }

  if (target.bot) {
    return interaction.reply({
      content:
        "❌ Botom nemožno prideľovať administračné tiery.",
      ephemeral: true
    });
  }

  if (![1, 2, 3].includes(tier)) {
    return interaction.reply({
      content: "❌ Neplatný tier.",
      ephemeral: true
    });
  }

  const { error } = await supabase
    .from("bot_admins")
    .upsert(
      {
        discord_id: target.id,
        added_by: interaction.user.id,
        tier
      },
      {
        onConflict: "discord_id"
      }
    );

  if (error) {
    throw new Error(
      `Supabase addadmin: ${error.message}`
    );
  }

  await auditLog(
    "Tier administrátora zmenený",
    `Owner: ${interaction.user.id}\nPoužívateľ: ${target.id}\nTier: ${tier}`,
    0x57F287
  );

  return interaction.reply({
    content:
      `✅ <@${target.id}> má teraz **SGooBot Tier ${tier}**.`,
    ephemeral: true,
    allowedMentions: {
      parse: []
    }
  });
}

// =========================================================
// OWNER: REMOVE ADMIN
// =========================================================

async function handleRemoveAdmin(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    await auditLog(
      "⚠️ Neoprávnený owner príkaz",
      `Používateľ: ${interaction.user.tag} (${interaction.user.id})\nPríkaz: /${interaction.commandName}`,
      0xED4245
    );

    return interaction.reply({
      content:
        "❌ Tento príkaz môže používať iba owner SGooBotu.",
      ephemeral: true
    });
  }

  const target = interaction.options.getUser("user", true);

  if (target.id === OWNER_ID) {
    return interaction.reply({
      content:
        "❌ Ownera nie je možné odobrať z owner oprávnení.",
      ephemeral: true
    });
  }

  const { error } = await supabase
    .from("bot_admins")
    .delete()
    .eq("discord_id", target.id);

  if (error) {
    console.error(
      "Supabase remove admin error:",
      error
    );

    return interaction.reply({
      content: "❌ Nepodarilo sa odobrať admina.",
      ephemeral: true
    });
  }

  return interaction.reply(
    `✅ <@${target.id}> bol odobraný zo **SGooBot adminov**.`
  );
}

// =========================================================
// ADMIN COMMAND HELPERS + HANDLERS
// =========================================================

async function botHasPermission(interaction, permission) {
  const me = interaction.guild?.members.me;
  return Boolean(me?.permissions.has(permission));
}

// =========================================================
// ADMIN: ADD ROLE
// =========================================================

async function handleAddRole(interaction) {
  const target = interaction.options.getUser("user", true);
  const role = interaction.options.getRole("role", true);
  const guild = interaction.guild;

  if (!guild) {
    return interaction.reply({
      content: "Použi tento príkaz na serveri.",
      ephemeral: true
    });
  }

  if (
    role.managed ||
    role.position >= guild.members.me.roles.highest.position
  ) {
    return interaction.reply({
      content:
        "❌ Túto rolu bot nemôže spravovať. Skontroluj hierarchiu rolí a integrácie.",
      ephemeral: true
    });
  }

  if (!(await botHasPermission(
    interaction,
    PermissionsBitField.Flags.ManageRoles
  ))) {
    return interaction.reply({
      content: "❌ Bot potrebuje oprávnenie Manage Roles.",
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const member = await guild.members.fetch(target.id);

    if (member.roles.cache.has(role.id)) {
      return interaction.editReply(
        `⚠️ Používateľ už má rolu ${role}.`
      );
    }

    await member.roles.add(
      role,
      `Príkaz /addrole od ${interaction.user.tag}`
    );

    await interaction.editReply(
      `✅ Používateľ <@${target.id}> dostal rolu ${role}.`
    );

    await auditLog(
      "Rola pridaná",
      `Admin: ${interaction.user.tag} (${interaction.user.id})\nPoužívateľ: ${target.tag} (${target.id})\nRola: ${role.name} (${role.id})`,
      0x57F287
    );

  } catch (error) {
    await interaction.editReply(
      "❌ Rolu sa nepodarilo pridať. Skontroluj oprávnenia bota."
    );

    throw error;
  }
}

// =========================================================
// ADMIN: REMOVE ROLE
// =========================================================

async function handleRemoveRole(interaction) {
  const target = interaction.options.getUser("user", true);
  const role = interaction.options.getRole("role", true);
  const guild = interaction.guild;

  if (!guild) {
    return interaction.reply({
      content: "Použi tento príkaz na serveri.",
      ephemeral: true
    });
  }

  if (
    role.managed ||
    role.position >= guild.members.me.roles.highest.position
  ) {
    return interaction.reply({
      content:
        "❌ Túto rolu bot nemôže spravovať. Skontroluj hierarchiu rolí a integrácie.",
      ephemeral: true
    });
  }

  if (!(await botHasPermission(
    interaction,
    PermissionsBitField.Flags.ManageRoles
  ))) {
    return interaction.reply({
      content: "❌ Bot potrebuje oprávnenie Manage Roles.",
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const member = await guild.members.fetch(target.id);

    if (!member.roles.cache.has(role.id)) {
      return interaction.editReply(
        `⚠️ Používateľ nemá rolu ${role}.`
      );
    }

    await member.roles.remove(
      role,
      `Príkaz /removerole od ${interaction.user.tag}`
    );

    await interaction.editReply(
      `✅ Používateľovi <@${target.id}> bola odobratá rola ${role}.`
    );

    await auditLog(
      "Rola odobratá",
      `Admin: ${interaction.user.tag} (${interaction.user.id})\nPoužívateľ: ${target.tag} (${target.id})\nRola: ${role.name} (${role.id})`,
      0xFEE75C
    );

  } catch (error) {
    await interaction.editReply(
      "❌ Rolu sa nepodarilo odobrať. Skontroluj oprávnenia bota."
    );

    throw error;
  }
}

// =========================================================
// ADMIN: MOVE USER
// =========================================================

async function handleMove(interaction) {
  const user = interaction.options.getUser("user", true);
  const to = interaction.options.getChannel("to", true);
  const from = interaction.options.getChannel("from");
  const guild = interaction.guild;

  if (!guild) {
    return interaction.reply({
      content: "Použi tento príkaz na serveri.",
      ephemeral: true
    });
  }

  if (!(await botHasPermission(
    interaction,
    PermissionsBitField.Flags.MoveMembers
  ))) {
    return interaction.reply({
      content: "❌ Bot potrebuje oprávnenie Move Members.",
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const member = await guild.members.fetch(user.id);

    if (!member.voice.channel) {
      return interaction.editReply(
        "❌ Používateľ momentálne nie je v hlasovom kanáli."
      );
    }

    if (from && member.voice.channelId !== from.id) {
      return interaction.editReply(
        `❌ Používateľ nie je v zadanom zdrojovom kanáli. Aktuálne je v ${member.voice.channel}.`
      );
    }

    await member.voice.setChannel(
      to,
      `Príkaz /move od ${interaction.user.tag}`
    );

    await interaction.editReply(
      `✅ <@${user.id}> bol presunutý do ${to}.`
    );

    await auditLog(
      "Používateľ presunutý",
      `Admin: ${interaction.user.tag} (${interaction.user.id})\nPoužívateľ: ${user.tag} (${user.id})\nZ: ${from ? from.name : "aktuálny hlasový kanál"}\nDo: ${to.name}`,
      0x57F287
    );

  } catch (error) {
    await interaction.editReply(
      "❌ Presun sa nepodaril. Skontroluj hlasové kanály a oprávnenia bota."
    );

    throw error;
  }
}

// =========================================================
// ADMIN: CLEAR MESSAGES
// =========================================================

async function handleClear(interaction) {
  const amount = interaction.options.getInteger(
    "amount",
    true
  );

  const channel = interaction.channel;

  if (
    !channel?.isTextBased() ||
    !channel.messages ||
    typeof channel.bulkDelete !== "function"
  ) {
    return interaction.reply({
      content:
        "❌ Tento príkaz funguje iba v bežnom textovom kanáli.",
      ephemeral: true
    });
  }

  if (!channel.permissionsFor(
    interaction.guild.members.me
  )?.has(PermissionsBitField.Flags.ManageMessages)) {
    return interaction.reply({
      content:
        "❌ Bot potrebuje oprávnenie Manage Messages v tomto kanáli.",
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const deleted = await channel.bulkDelete(amount, true);
    const skipped = amount - deleted.size;

    await interaction.editReply(
      `🧹 Vymazaných správ: **${deleted.size}**.` +
      (
        skipped > 0
          ? `\n⚠️ ${skipped} správ sa nevymazalo, pravdepodobne sú staršie ako 14 dní.`
          : ""
      )
    );

    await auditLog(
      "Správy vymazané",
      `Admin: ${interaction.user.tag} (${interaction.user.id})\nKanál: #${channel.name} (${channel.id})\nPožadované: ${amount}\nVymazané: ${deleted.size}`,
      0xFEE75C
    );

  } catch (error) {
    await interaction.editReply(
      "❌ Správy sa nepodarilo vymazať. Skontroluj oprávnenia bota."
    );

    throw error;
  }
}

// =========================================================
// ADMIN: SLOWMODE
// =========================================================

async function handleSlowmode(interaction) {
  const seconds = interaction.options.getInteger(
    "seconds",
    true
  );

  const channel = interaction.channel;

  if (
    !channel?.isTextBased() ||
    typeof channel.setRateLimitPerUser !== "function"
  ) {
    return interaction.reply({
      content: "❌ Tento kanál nepodporuje slowmode.",
      ephemeral: true
    });
  }

  if (!channel.permissionsFor(
    interaction.guild.members.me
  )?.has(PermissionsBitField.Flags.ManageChannels)) {
    return interaction.reply({
      content:
        "❌ Bot potrebuje oprávnenie Manage Channels v tomto kanáli.",
      ephemeral: true
    });
  }

  try {
    await channel.setRateLimitPerUser(
      seconds,
      `Príkaz /slowmode od ${interaction.user.tag}`
    );

    await interaction.reply({
      content:
        seconds === 0
          ? "✅ Slowmode bol vypnutý."
          : `✅ Slowmode nastavený na **${seconds} sekúnd**.`,
      ephemeral: true
    });

    await auditLog(
      "Slowmode zmenený",
      `Admin: ${interaction.user.tag} (${interaction.user.id})\nKanál: #${channel.name} (${channel.id})\nSekundy: ${seconds}`,
      0x57F287
    );

  } catch (error) {
    console.error("Slowmode error:", error);

    await interaction.reply({
      content: "❌ Slowmode sa nepodarilo nastaviť.",
      ephemeral: true
    });
  }
}

// =========================================================
// ADMIN: ROLE INFO
// =========================================================

async function handleRoleInfo(interaction) {
  const role = interaction.options.getRole("role", true);
  const guild = interaction.guild;
  const members = await guild.members.fetch();

  const count = members.filter(
    m => m.roles.cache.has(role.id)
  ).size;

  const embed = new EmbedBuilder()
    .setTitle(`Informácie o role: ${role.name}`)
    .setColor(role.color || 0x5865F2)
    .addFields(
      { name: "ID", value: role.id },
      { name: "Farba", value: role.hexColor, inline: true },
      { name: "Členovia", value: String(count), inline: true },
      {
        name: "Vytvorená",
        value: `<t:${Math.floor(role.createdTimestamp / 1000)}:F>`
      },
      {
        name: "Pozícia",
        value: String(role.position),
        inline: true
      }
    )
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

async function handleUserInfo(interaction) {
  const user = interaction.options.getUser("user", true);
  const guild = interaction.guild;

  let member;

  try {
    member = await guild.members.fetch(user.id);
  } catch {
    return interaction.reply({
      content: "❌ Používateľ nie je členom tohto servera.",
      ephemeral: true
    });
  }

  const roles = member.roles.cache
    .filter(r => r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map(r => r.toString());

  const roleText = roles.length
    ? roles.join(", ").slice(0, 1000)
    : "Žiadne";

  const status = member.presence?.status ||
    "neznámy";

  const embed = new EmbedBuilder()
    .setTitle(`Informácie o používateľovi: ${user.tag}`)
    .setThumbnail(user.displayAvatarURL())
    .setColor(0x5865F2)
    .addFields(
      { name: "ID používateľa", value: user.id },
      {
        name: "Prezývka",
        value: member.nickname || "Žiadna",
        inline: true
      },
      {
        name: "Stav",
        value: status,
        inline: true
      },
      {
        name: "Účet vytvorený",
        value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`
      },
      {
        name: "Vstup na server",
        value: member.joinedTimestamp
          ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`
          : "Neznámy"
      },
      {
        name: `Roly (${roles.length})`,
        value: roleText
      }
    )
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

async function handleAnnounce(interaction) {
  const channel = interaction.options.getChannel("channel", true);
  const title = interaction.options.getString("title", true);
  const message = interaction.options.getString("text", true);

  if (
    !channel.isTextBased() ||
    typeof channel.send !== "function"
  ) {
    return interaction.reply({
      content: "❌ Tento kanál nepodporuje správy.",
      ephemeral: true
    });
  }

  const perms = channel.permissionsFor(
    interaction.guild.members.me
  );

  if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
    return interaction.reply({
      content: "❌ Bot nemá Send Messages.",
      ephemeral: true
    });
  }

  const content = `**${title}**\n\n${message}`;

  if (content.length > 2000) {
    return interaction.reply({
      content: "❌ Oznámenie presahuje 2000 znakov.",
      ephemeral: true
    });
  }

  const everyoneAllowed = perms.has(
    PermissionsBitField.Flags.MentionEveryone
  );

  if (
    !everyoneAllowed &&
    /@everyone|@here|<@&\d{17,20}>/.test(content)
  ) {
    return interaction.reply({
      content: "❌ Bot nemá oprávnenie na tieto zmienky.",
      ephemeral: true
    });
  }

  const sent = await channel.send({
    content,
    allowedMentions: {
      parse: everyoneAllowed
        ? ["users", "roles", "everyone"]
        : ["users"]
    }
  });

  await interaction.reply({
    content:
      `✅ Oznámenie odoslané do ${channel}.\n${sent.url}`,
    ephemeral: true
  });

  await auditLog(
    "Oznámenie odoslané",
    `Admin: ${interaction.user.tag} (${interaction.user.id})\nKanál: ${channel.id}\nSpráva: ${sent.id}`,
    0x57F287
  );
}

async function handleCommands(interaction) {
  const tier = await getAdminTier(interaction.user.id);

  const lines = [
    "🤖 **SGooBot – Príkazy**",
    `Tvoj tier: **${tier === 4 ? "Owner" : tier}**`,
    "",
    "**Pre všetkých:** /commands, /balance, /flip, /daily, /leaderboard, /custom create"
  ];

  if (tier >= 1) {
    lines.push(
      "**Tier 1:** /addpoints, /removepoints, /setpoints, /resetpoints"
    );
  }

  if (tier >= 2) {
    lines.push(
      "**Tier 2:** /move, /clear, /slowmode, /roleinfo, /userinfo"
    );
  }

  if (tier >= 3) {
    lines.push(
      "**Tier 3:** /addrole, /removerole, /announce, /pm-role, /blacklist, /unblacklist"
    );
  }

  if (tier === 4) {
    lines.push(
      "**Owner:** /addadmin, /removeadmin"
    );
  }

  return interaction.reply({
    content: lines.join("\n"),
    ephemeral: true
  });
}

// =========================================================
// CUSTOM 5V5
// =========================================================

const customGames = new Map();
const customBusy = new Set();

function customMix(ids) {
  const a = [...ids];

  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}

function customEmbed(g) {
  return new EmbedBuilder()
    .setTitle("🎮 SGooBot | Custom Game 5v5")
    .setColor(
      g.status === "playing"
        ? 0x57F287
        : g.status === "ended"
          ? 0x747F8D
          : 0x5865F2
    )
    .setDescription(
      `**Game ID:** ${g.id}\n` +
      `**Organizátor:** <@${g.owner}>\n` +
      `**Stav:** ${
        g.status === "waiting"
          ? "🟡 Pripravená"
          : g.status === "playing"
            ? "🟢 Prebieha"
            : "🔴 Ukončená"
      }`
    )
    .addFields(
      {
        name: "🔵 Blue Team",
        value: g.blue.map(id => `<@${id}>`).join("\n"),
        inline: true
      },
      {
        name: "🔴 Red Team",
        value: g.red.map(id => `<@${id}>`).join("\n"),
        inline: true
      }
    )
    .setTimestamp();
}

function customRows(g) {
  if (g.status === "ended") return [];

  const row = new ActionRowBuilder();

  if (g.status === "waiting") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`cg:start:${g.id}`)
        .setLabel("Spustiť hru")
        .setStyle(ButtonStyle.Success)
        .setEmoji("▶️"),

      new ButtonBuilder()
        .setCustomId(`cg:shuffle:${g.id}`)
        .setLabel("Zamiešať")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🔀")
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`cg:swap:${g.id}`)
      .setLabel("Vymeniť hráčov")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔄"),

    new ButtonBuilder()
      .setCustomId(`cg:end:${g.id}`)
      .setLabel("Ukončiť")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🛑")
  );

  return [row];
}

async function customRefresh(g) {
  await g.message.edit({
    embeds: [customEmbed(g)],
    components: customRows(g),
    allowedMentions: {
      parse: []
    }
  });
}

async function customAuthorized(interaction, game) {
  return (
    interaction.user.id === game.owner ||
    (await getAdminTier(interaction.user.id)) >= 3
  );
}

async function handleCustomCreate(interaction) {
  await interaction.deferReply({
    ephemeral: true
  });

  if (!interaction.guild) {
    return interaction.editReply(
      "❌ Príkaz funguje iba na serveri."
    );
  }

  if (customGames.has(interaction.guildId)) {
    return interaction.editReply(
      "❌ Na serveri už je aktívna custom hra."
    );
  }

  const waitingId = process.env.CUSTOM_WAITING_CHANNEL_ID;
  const categoryId = process.env.CUSTOM_CATEGORY_ID;

  if (!waitingId || !categoryId) {
    return interaction.editReply(
      "❌ Nastav CUSTOM_WAITING_CHANNEL_ID a CUSTOM_CATEGORY_ID na Renderi."
    );
  }

  const waiting = await interaction.guild.channels.fetch(
    waitingId
  );

  const category = await interaction.guild.channels.fetch(
    categoryId
  );

  if (
    waiting?.type !== ChannelType.GuildVoice ||
    category?.type !== ChannelType.GuildCategory ||
    waiting.guildId !== interaction.guildId ||
    category.guildId !== interaction.guildId
  ) {
    return interaction.editReply(
      "❌ Nesprávne ID čakacej roomky alebo kategórie."
    );
  }

  const ids = [...waiting.members.values()]
    .filter(member => !member.user.bot)
    .map(member => member.id);

  if (ids.length !== 10) {
    return interaction.editReply(
      `❌ V čakacej roomke musí byť presne 10 hráčov. Teraz: ${ids.length}/10.`
    );
  }

  const mixed = customMix(ids);

  const game = {
    id: crypto.randomBytes(4).toString("hex"),
    owner: interaction.user.id,
    guildId: interaction.guildId,
    waitingId,
    categoryId,
    blue: mixed.slice(0, 5),
    red: mixed.slice(5),
    status: "waiting",
    blueChannel: null,
    redChannel: null,
    message: null
  };

  customGames.set(interaction.guildId, game);

  try {
    game.message = await interaction.channel.send({
      embeds: [customEmbed(game)],
      components: customRows(game),
      allowedMentions: {
        parse: []
      }
    });

    await auditLog(
      "Custom 5v5 vytvorená",
      `Game: ${game.id}\nOrganizátor: ${game.owner}`
    );

    return interaction.editReply(
      "✅ Custom 5v5 bola vytvorená."
    );

  } catch (error) {
    customGames.delete(interaction.guildId);
    throw error;
  }
}

async function customStart(interaction, game) {
  const guild = interaction.guild;

  const waiting = await guild.channels.fetch(
    game.waitingId
  );

  const category = await guild.channels.fetch(
    game.categoryId
  );

  if (
    !waiting ||
    category?.type !== ChannelType.GuildCategory
  ) {
    throw Error(
      "Čakacia roomka alebo kategória už neexistuje."
    );
  }

  for (const id of [...game.blue, ...game.red]) {
    const member = await guild.members.fetch(id);

    if (member.voice.channelId !== game.waitingId) {
      throw Error(
        `Hráč <@${id}> nie je v čakacej roomke.`
      );
    }
  }

  let blue;
  let red;

  try {
    blue = await guild.channels.create({
      name: `🔵 Blue Team | ${game.id}`,
      type: ChannelType.GuildVoice,
      parent: category.id,
      userLimit: 5
    });

    red = await guild.channels.create({
      name: `🔴 Red Team | ${game.id}`,
      type: ChannelType.GuildVoice,
      parent: category.id,
      userLimit: 5
    });

  } catch (error) {
    if (blue) {
      await blue.delete().catch(() => {});
    }

    throw error;
  }

  game.blueChannel = blue.id;
  game.redChannel = red.id;
  game.status = "playing";

  const failed = [];

  for (const [team, channel] of [
    [game.blue, blue],
    [game.red, red]
  ]) {
    for (const id of team) {
      try {
        const member = await guild.members.fetch(id);
        await member.voice.setChannel(channel);
      } catch {
        failed.push(id);
      }
    }
  }

  await customRefresh(game);

  await auditLog(
    "Custom 5v5 spustená",
    `Game: ${game.id}\nNepresunutí: ${
      failed.join(", ") || "nikto"
    }`
  );

  return failed.length
    ? `⚠️ Hra spustená, ale ${failed.length} hráčov sa nepodarilo presunúť.`
    : "✅ Hra spustená, všetci hráči presunutí.";
}

async function customSwap(
  interaction,
  game,
  blueId,
  redId
) {
  if (
    !game.blue.includes(blueId) ||
    !game.red.includes(redId)
  ) {
    throw Error(
      "Výber hráčov už nie je aktuálny."
    );
  }

  if (game.status === "playing") {
    const guild = interaction.guild;

    const a = await guild.members.fetch(blueId);
    const b = await guild.members.fetch(redId);

    if (
      a.voice.channelId !== game.blueChannel ||
      b.voice.channelId !== game.redChannel
    ) {
      throw Error(
        "Obaja hráči musia byť vo svojich tímových roomkách."
      );
    }

    const waiting = await guild.channels.fetch(
      game.waitingId
    );

    const blue = await guild.channels.fetch(
      game.blueChannel
    );

    const red = await guild.channels.fetch(
      game.redChannel
    );

    if (!waiting || !blue || !red) {
      throw Error(
        "Niektorá roomka už neexistuje."
      );
    }

    await a.voice.setChannel(waiting);

    try {
      await b.voice.setChannel(blue);
      await a.voice.setChannel(red);

    } catch {
      await b.voice.setChannel(red).catch(() => {});
      await a.voice.setChannel(blue).catch(() => {});

      throw Error(
        "Presun hráčov zlyhal. Skontroluj ich roomky."
      );
    }
  }

  game.blue = game.blue.map(
    id => id === blueId ? redId : id
  );

  game.red = game.red.map(
    id => id === redId ? blueId : id
  );

  await customRefresh(game);

  return "✅ Hráči boli vymenení.";
}

async function customEnd(interaction, game) {
  const problems = [];

  for (const id of [
    game.blueChannel,
    game.redChannel
  ]) {
    if (!id) continue;

    const channel = await interaction.guild.channels
      .fetch(id)
      .catch(() => null);

    if (!channel) continue;

    for (const member of [...channel.members.values()]) {
      try {
        await member.voice.setChannel(
          game.waitingId
        );
      } catch {
        problems.push(member.id);
      }
    }

    const fresh = await interaction.guild.channels
      .fetch(id)
      .catch(() => null);

    if (fresh?.members.size === 0) {
      await fresh.delete().catch(() => {});
    }
  }

  game.status = "ended";

  await customRefresh(game);

  customGames.delete(game.guildId);

  await auditLog(
    "Custom 5v5 ukončená",
    `Game: ${game.id}\nUkončil: ${
      interaction.user.id
    }\nNepresunutí: ${
      problems.join(", ") || "nikto"
    }`
  );

  return problems.length
    ? `⚠️ Hra ukončená, ${problems.length} hráčov nebolo možné vrátiť.`
    : "✅ Hra ukončená a roomky upratané.";
}

async function handleCustomComponent(interaction) {
  const [
    prefix,
    action,
    id,
    selectedBlue
  ] = interaction.customId.split(":");

  const game = customGames.get(
    interaction.guildId
  );

  if (!game || game.id !== id) {
    return interaction.reply({
      content:
        "❌ Táto hra už nie je aktívna (možno sa reštartoval bot).",
      ephemeral: true
    });
  }

  if (!(await customAuthorized(interaction, game))) {
    return interaction.reply({
      content:
        "❌ Ovládať môže iba organizátor alebo Tier 3 admin.",
      ephemeral: true
    });
  }

  if (action === "swap") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`cg:blue:${id}`)
      .setPlaceholder("Vyber hráča z Blue Teamu")
      .addOptions(
        game.blue.map((playerId, index) => ({
          label: `Blue hráč ${index + 1}`,
          description: `Discord ID: ${playerId}`,
          value: playerId
        }))
      );

    return interaction.reply({
      content: "Vyber hráča z Blue Teamu:",
      components: [
        new ActionRowBuilder().addComponents(menu)
      ],
      ephemeral: true
    });
  }

  if (action === "blue") {
    const blueId = interaction.values[0];

    if (!game.blue.includes(blueId)) {
      return interaction.update({
        content:
          "❌ Hráč už nie je v Blue Teame.",
        components: []
      });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`cg:red:${id}:${blueId}`)
      .setPlaceholder("Vyber hráča z Red Teamu")
      .addOptions(
        game.red.map((playerId, index) => ({
          label: `Red hráč ${index + 1}`,
          description: `Discord ID: ${playerId}`,
          value: playerId
        }))
      );

    return interaction.update({
      content:
        `Blue hráč: <@${blueId}>. Vyber Red hráča:`,
      components: [
        new ActionRowBuilder().addComponents(menu)
      ],
      allowedMentions: {
        parse: []
      }
    });
  }

  await interaction.deferUpdate();

  if (customBusy.has(interaction.guildId)) {
    return interaction.followUp({
      content: "⏳ Práve prebieha iná akcia.",
      ephemeral: true
    });
  }

  customBusy.add(interaction.guildId);

  try {
    let result;

    if (action === "shuffle") {
      if (game.status !== "waiting") {
        throw Error(
          "Zamiešať možno iba pred spustením."
        );
      }

      const ids = customMix([
        ...game.blue,
        ...game.red
      ]);

      game.blue = ids.slice(0, 5);
      game.red = ids.slice(5);

      await customRefresh(game);

      result = "🔀 Tímy zamiešané.";

    } else if (action === "start") {
      if (game.status !== "waiting") {
        throw Error(
          "Hra už bola spustená."
        );
      }

      result = await customStart(
        interaction,
        game
      );

    } else if (action === "red") {
      result = await customSwap(
        interaction,
        game,
        selectedBlue,
        interaction.values[0]
      );

    } else if (action === "end") {
      result = await customEnd(
        interaction,
        game
      );

    } else {
      throw Error("Neznáma akcia.");
    }

    return interaction.followUp({
      content: result,
      ephemeral: true,
      allowedMentions: {
        parse: []
      }
    });

  } catch (error) {
    console.error("Custom 5v5:", error);

    return interaction.followUp({
      content: `❌ ${error.message}`,
      ephemeral: true,
      allowedMentions: {
        parse: []
      }
    });

  } finally {
    customBusy.delete(interaction.guildId);
  }
}

// =========================================================
// INTERACTION HANDLER
// =========================================================

client.on("interactionCreate", async interaction => {
  if (
    (
      interaction.isButton() ||
      interaction.isStringSelectMenu()
    ) &&
    interaction.customId.startsWith("cg:")
  ) {
    try {
      await handleCustomComponent(interaction);

    } catch (error) {
      console.error("Custom component:", error);

      const msg = {
        content: "❌ Chyba custom hry.",
        ephemeral: true
      };

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction.followUp(msg).catch(() => {});
      } else {
        await interaction.reply(msg).catch(() => {});
      }
    }

    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const commandHandlers = {
    custom: handleCustomCreate,
    commands: handleCommands,
    "pm-role": handlePmRole,
    balance: handleBalance,
    flip: handleFlip,
    daily: handleDaily,
    leaderboard: handleLeaderboard,
    addpoints: handleAddPoints,
    removepoints: handleRemovePoints,
    setpoints: handleSetPoints,
    resetpoints: handleResetPoints,
    blacklist: handleBlacklist,
    unblacklist: handleUnblacklist,
    addadmin: handleAddAdmin,
    removeadmin: handleRemoveAdmin,
    addrole: handleAddRole,
    removerole: handleRemoveRole,
    move: handleMove,
    clear: handleClear,
    slowmode: handleSlowmode,
    roleinfo: handleRoleInfo,
    userinfo: handleUserInfo,
    announce: handleAnnounce
  };

  const handler = commandHandlers[
    interaction.commandName
  ];

  if (!handler) return;

  try {
    const requiredTier =
      COMMAND_TIERS[interaction.commandName] || 0;

    if (
      requiredTier &&
      !(await requireTier(
        interaction,
        requiredTier
      ))
    ) {
      return;
    }

  } catch (error) {
    console.error(
      "Tier lookup failed:",
      error
    );

    await interaction.reply({
      content:
        "❌ Nepodarilo sa overiť oprávnenia. Skontroluj Supabase.",
      ephemeral: true
    }).catch(() => {});

    return;
  }

  await auditLog(
    "Príkaz použitý",
    `Používateľ: ${interaction.user.tag} (${interaction.user.id})\n` +
    `Príkaz: /${interaction.commandName}\n` +
    `Server: ${interaction.guild?.name || "DM"}\n` +
    `Kanál: ${interaction.channel?.name || "neznámy"}`,
    0x5865F2
  );

  try {
    await handler(interaction);

    await auditLog(
      "Handler príkazu dokončený",
      `Používateľ: ${interaction.user.tag}\n` +
      `Príkaz: /${interaction.commandName}`,
      0x57F287
    );

  } catch (error) {
    console.error(
      `Command ${interaction.commandName} failed:`,
      error
    );

    await auditLog(
      "❌ Chyba príkazu",
      `Používateľ: ${interaction.user.tag}\n` +
      `Príkaz: /${interaction.commandName}\n` +
      `Chyba: ${error?.message || "neznáma chyba"}`,
      0xED4245
    );

    const message =
      "❌ Pri vykonávaní príkazu nastala chyba.";

    if (
      interaction.replied ||
      interaction.deferred
    ) {
      await interaction.editReply({
        content: message
      }).catch(() => {});

    } else {
      await interaction.reply({
        content: message,
        ephemeral: true
      }).catch(() => {});
    }
  }
});

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
