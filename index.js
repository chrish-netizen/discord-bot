require("dotenv").config();
const fs = require("fs");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const OpenAI = require("openai");

const OWNER_ID = process.env.OWNER_ID;

// =====================
// CLIENT
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// =====================
// OPENAI
// =====================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =====================
// LEVEL SYSTEM (PER GUILD)
// =====================
const LEVEL_FILE = "./levels.json";
if (!fs.existsSync(LEVEL_FILE)) fs.writeFileSync(LEVEL_FILE, "{}");

function loadLevels() {
  return JSON.parse(fs.readFileSync(LEVEL_FILE, "utf8"));
}

function saveLevels(data) {
  fs.writeFileSync(LEVEL_FILE, JSON.stringify(data, null, 2));
}

function addXP(guildId, userId, amount) {
  const levels = loadLevels();

  if (!levels[guildId]) levels[guildId] = {};
  if (!levels[guildId][userId]) {
    levels[guildId][userId] = { xp: 0, level: 1 };
  }

  const user = levels[guildId][userId];
  user.xp += amount;

  let leveledUp = false;

  while (user.xp >= user.level * 100) {
    user.xp -= user.level * 100;
    user.level++;
    leveledUp = true;
  }

  saveLevels(levels);
  return leveledUp ? user.level : null;
}

function getUserLevel(guildId, userId) {
  const levels = loadLevels();
  return levels[guildId]?.[userId] || { level: 1, xp: 0 };
}

function getLeaderboard(guildId, limit = 10) {
  const levels = loadLevels();
  if (!levels[guildId]) return [];

  return Object.entries(levels[guildId])
    .sort((a, b) =>
      b[1].level !== a[1].level
        ? b[1].level - a[1].level
        : b[1].xp - a[1].xp
    )
    .slice(0, limit);
}

// =====================
// MEMORY
// =====================
const memory = new Map();
const MEMORY_LIMIT = 12;

// =====================
// MOOD DETECTION
// =====================
function detectMood(text) {
  const t = text.toLowerCase();

  if (t.includes("sad") || t.includes("tired") || t.includes("done"))
    return "supportive";
  if (t.includes("you suck") || t.includes("trash") || t.includes("ratio"))
    return "hostile";
  if (t.includes("lol") || t.includes("lmao") || t.includes("bro"))
    return "playful";
  if (t.length < 5) return "dry";

  return "neutral";
}

// =====================
// PERSONA
// =====================
const SYSTEM_PROMPT = `
You are Alex.
Early 20s. Gen-Z Discord energy.
Casual, sarcastic, confident.

Rules:
- 1–3 short sentences
- Smart, context-aware roasts
- Supportive when needed
- Tease dry messages
- No emojis
- Never mention being an AI
`;

// =====================
// READY
// =====================
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// =====================
// MESSAGE HANDLER
// =====================
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const guildId = message.guild.id;
  const userId = message.author.id;
  const text = message.content;
  const lower = text.toLowerCase();

  // -------- !ping --------
  if (lower === "!ping") {
    const reply = await message.reply("pong.");
    const latency = reply.createdTimestamp - message.createdTimestamp;
    const apiLatency = Math.round(client.ws.ping);

    return reply.edit(
      `🏓 **Pong!**\nMessage latency: **${latency}ms**\nAPI latency: **${apiLatency}ms**`
    );
  }

  // -------- !restart (OWNER ONLY) --------
  if (lower === "!restart") {
    if (userId !== OWNER_ID)
      return message.reply("nah. you don’t have the keys.");

    await message.reply("restarting. don’t miss me.");
    process.exit(0);
  }

  // -------- !level --------
  if (lower === "!level") {
    const data = getUserLevel(guildId, userId);
    return message.reply(
      `Level **${data.level}**, **${data.xp} XP**. respectable.`
    );
  }

  // -------- !leaderboard (EMBED) --------
  if (lower === "!leaderboard") {
    const board = getLeaderboard(guildId);
    if (!board.length)
      return message.channel.send("nobody’s grinding yet.");

    const embed = new EmbedBuilder()
      .setTitle("🏆 Server Leaderboard")
      .setColor(0x5865f2)
      .setDescription(
        board
          .map(
            ([id, data], i) =>
              `**${i + 1}.** <@${id}> — Level ${data.level} (${data.xp} XP)`
          )
          .join("\n")
      );

    return message.channel.send({ embeds: [embed] });
  }

  // -------- XP FOR TALKING --------
  const newLevel = addXP(guildId, userId, 10);
  if (newLevel) {
    message.channel.send(
      `🎉 <@${userId}> hit **Level ${newLevel}**. lore update.`
    );
  }

  // -------- SHOULD RESPOND --------
  const triggered =
    message.mentions.has(client.user) ||
    lower.includes("seyluns ai") ||
    lower.includes("seyluns robot");

  if (!triggered) return;

  // -------- MEMORY --------
  const key = `${guildId}:${userId}`;
  if (!memory.has(key)) memory.set(key, []);

  const userMemory = memory.get(key);
  userMemory.push({ role: "user", content: text });
  while (userMemory.length > MEMORY_LIMIT) userMemory.shift();

  const mood = detectMood(text);
  let temperature = 0.85;
  if (mood === "supportive") temperature = 0.6;
  if (mood === "hostile") temperature = 1.0;

  // -------- AI RESPONSE --------
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature,
      max_tokens: 120,
      messages: [
        { role: "system", content: SYSTEM_PROMPT + `\nMood: ${mood}` },
        ...userMemory,
      ],
    });

    const reply = completion.choices[0].message.content?.trim();
    if (!reply) return;

    userMemory.push({ role: "assistant", content: reply });
    while (userMemory.length > MEMORY_LIMIT) userMemory.shift();

    await message.reply(reply);
  } catch (err) {
    console.error("OpenAI error:", err);
  }
});

// =====================
// VC XP (SAFE)
// =====================
setInterval(() => {
  client.guilds.cache.forEach((guild) => {
    guild.voiceStates.cache.forEach((state) => {
      if (!state.member || state.member.user.bot || !state.channel) return;

      const newLevel = addXP(guild.id, state.member.id, 5);
      if (newLevel && guild.systemChannel) {
        guild.systemChannel.send(
          `🎉 <@${state.member.id}> hit **Level ${newLevel}** just chilling in VC.`
        );
      }
    });
  });
}, 60_000);

// =====================
// LOGIN
// =====================
client.login(process.env.DISCORD_TOKEN);
