import express from "express";
import crypto from "node:crypto";
import {
  Client,
  GatewayIntentBits
} from "discord.js";

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

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

const port = Number(process.env.PORT || 3000);

function safeEqual(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

app.get("/", (_req, res) => {
  res.status(200).send("Nabor bot is running.");
});

app.post("/assign-role", async (req, res) => {
  const auth = req.get("authorization") || "";
  const suppliedSecret = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";

  if (!safeEqual(suppliedSecret, process.env.WEBHOOK_SECRET)) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  const discordId = String(req.body?.discordId ?? "").trim();

  // Discord user IDs are numeric snowflakes.
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

    console.log(`Role assigned to ${discordId}`);

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

client.once("clientReady", (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

app.listen(port, "0.0.0.0", () => {
  console.log(`HTTP server listening on ${port}`);
});