
import express from "express";
import crypto from "node:crypto";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} from "discord.js";

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

function authorized(req, res) {
  const auth = req.get("authorization") || "";
  const secret = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";

  if (!safeEqual(secret, process.env.WEBHOOK_SECRET)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  return true;
}

app.get("/", (_req, res) => {
  res.status(200).send("Nabor bot is running.");
});

// Odoslanie prihlášky priamo cez Discord bota.
app.post("/submit-application", async (req, res) => {
  if (!authorized(req, res)) return;

  if (!client.isReady()) {
    return res.status(503).json({ error: "Bot is not ready" });
  }

  const answers = req.body?.answers;

  if (
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers)
  ) {
    return res.status(400).json({ error: "Invalid answers" });
  }

  const entries = Object.entries(answers);

  if (entries.length === 0 || entries.length > 25) {
    return res.status(400).json({
      error: "Prihláška musí obsahovať 1 až 25 odpovedí."
    });
  }

  const fields = entries.map(([question, answer]) => ({
    name: String(question).slice(0, 256) || "Otázka",
    value: String(answer ?? "Bez odpovede").slice(0, 1024) || "Bez odpovede",
    inline: false
  }));

  const totalLength = fields.reduce(
    (sum, field) => sum + field.name.length + field.value.length,
    0
  );

  if (totalLength > 5500) {
    return res.status(400).json({
      error: "Prihláška je príliš dlhá na jednu Discord správu."
    });
  }

  try {
    const channel = await client.channels.fetch(
      process.env.APPLICATION_CHANNEL_ID
    );

    if (!channel || !channel.isTextBased() || !channel.send) {
      return res.status(500).json({
        error: "Náborový kanál sa nenašiel alebo nie je textový."
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("📩 Nová náborová prihláška")
      .setColor(0x5865F2)
      .addFields(fields)
      .setFooter({ text: "Streamers Clash | Nábor" })
      .setTimestamp();

    const message = await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });

    console.log(`Prihláška odoslaná: ${message.id}`);

    return res.status(200).json({
      ok: true,
      messageId: message.id
    });
  } catch (error) {
    console.error("Odoslanie prihlášky zlyhalo:", error.code || error.message);

    return res.status(500).json({
      error: "Nepodarilo sa odoslať prihlášku do Discordu."
    });
  }
});

// Existujúce prideľovanie roly ponechávame.
app.post("/assign-role", async (req, res) => {
  if (!authorized(req, res)) return;

  const discordId = String(req.body?.discordId ?? "").trim();

  if (!/^\d{17,20}$/.test(discordId)) {
    return res.status(400).json({ error: "Invalid Discord ID" });
  }

  if (!client.isReady()) {
    return res.status(503).json({ error: "Bot is not ready" });
  }

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const role = await guild.roles.fetch(process.env.ROLE_ID);

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
