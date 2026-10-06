import express from "express";
import crypto from "node:crypto";

import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

// =========================================================
// ENVIRONMENT VARIABLES
// =========================================================

const required = [
  "DISCORD_TOKEN",
  "GUILD_ID",
  "ROLE_ID",
  "WEBHOOK_SECRET"
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
app.use(express.json({ limit: "10kb" }));

const port = Number(process.env.PORT || 3000);

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
  const first = Buffer.from(a);
  const second = Buffer.from(b);

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

  if (!safeEqual(suppliedSecret, process.env.WEBHOOK_SECRET)) {
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
  res.status(200).send("Nabor bot is running.");
});

// =========================================================
// ASSIGN ROLE
// =========================================================

app.post("/assign-role", async (req, res) => {
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
      `Role assigned to ${discordId}`
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
});

// =========================================================
// /pm-role COMMAND
// =========================================================

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
// REGISTER SLASH COMMANDS
// =========================================================

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
        body: [
          pmRoleCommand.toJSON()
        ]
      }
    );

    console.log(
      "Slash command /pm-role zaregistrovaný."
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

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName !== "pm-role") {
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

    const role = interaction.options.getRole(
      "role",
      true
    );

    const message = interaction.options.getString(
      "sprava",
      true
    );

    await interaction.deferReply({
      ephemeral: true
    });

    try {

      const guild = interaction.guild;

      if (!guild) {
        return interaction.editReply(
          "❌ Tento príkaz je možné použiť iba na serveri."
        );
      }

      // ===================================================
      // FETCH MEMBERS
      // ===================================================

      const members = await guild.members.fetch();

      // ===================================================
      // MEMBERS WITH SELECTED ROLE
      // ===================================================

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

      // ===================================================
      // COUNTERS
      // ===================================================

      let sent = 0;

      const failed = [];

      // ===================================================
      // SEND DMS
      // ===================================================

      for (const member of roleMembers.values()) {

        try {

          await member.send({
            content: message
          });

          sent++;

          console.log(
            `DM odoslané: ${member.user.tag}`
          );

        } catch (error) {

          let reason = "Neznáma chyba";

          if (error.code === 50007) {
            reason =
              "Používateľ nemôže prijímať DM od bota";
          } else if (error.code) {
            reason =
              `Discord chyba ${error.code}`;
          } else if (error.message) {
            reason = error.message;
          }

          failed.push({
            name: member.user.tag,
            id: member.user.id,
            reason
          });

          console.log(
            `DM sa nepodarilo odoslať: ${member.user.tag} | ${reason}`
          );
        }

        // =================================================
        // SMALL DELAY
        // =================================================

        await new Promise(resolve =>
          setTimeout(resolve, 1000)
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

      if (failed.length > 0) {

        result.push(
          "",
          "**❌ Neodoslané správy:**"
        );

        for (const user of failed) {

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
