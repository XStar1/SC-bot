import express from "express";
import crypto from "node:crypto";

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
  "APPLICATION_CHANNEL_ID"
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Chýba premenná: ${name}`);
  }
}

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
// /pm-role COMMAND
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

// =========================================================
// REGISTER SLASH COMMAND
// =========================================================

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
        body: [
          pmRoleCommand.toJSON()
        ]
      }
    );

    console.log(
      "/pm-role zaregistrovaný."
    );

  } catch (error) {

    console.error(
      "Registrácia slash commandu zlyhala:",
      error
    );
  }
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

    if (
      interaction.commandName !==
      "pm-role"
    ) {
      return;
    }

    // =====================================================
    // ADMIN CHECK
    // =====================================================

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

    // =====================================================
    // OPTIONS
    // =====================================================

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

      // ===================================================
      // FETCH MEMBERS
      // ===================================================

      const members =
        await guild.members.fetch();

      // ===================================================
      // FILTER ROLE MEMBERS
      // ===================================================

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

      // ===================================================
      // COUNTERS
      // ===================================================

      let sent = 0;

      const failed = [];

      // ===================================================
      // SEND DMS
      // ===================================================

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

        // =================================================
        // DELAY
        // =================================================

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1000
            )
        );
      }

      // ===================================================
      // RESULT
      // ===================================================

      const result = [

        "📨 **Hromadná PM dokončená.**",

        "",

        `👥 Rola: ${role}`,

        `📨 Odoslané: **${sent}**`,

        `❌ Neodoslané: **${failed.length}**`,

        `👥 Celkom: **${roleMembers.size}**`
      ];

      // ===================================================
      // FAILED USERS
      // ===================================================

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
