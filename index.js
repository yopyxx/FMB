// @ts-nocheck

const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1018194815286001756';

const SUPERVISOR_ROLE_IDS = [
  '1018195904261529691',
  '1473688580613341419'
];

const MAJOR_ROLE_ID = '1472582859339596091';
const LTCOL_ROLE_ID = '1018447060627894322';

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'admin_data.json');

let data = {
  소령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' },
  중령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' }
};

function loadData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    saveData();
  }

  if (!data.소령) data.소령 = { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' };
  if (!data.중령) data.중령 = { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' };

  if (!data.소령.history) data.소령.history = { daily: {}, weekly: {} };
  if (!data.중령.history) data.중령.history = { daily: {}, weekly: {} };
  if (!data.소령.history.daily) data.소령.history.daily = {};
  if (!data.중령.history.daily) data.중령.history.daily = {};
  if (!data.소령.history.weekly) data.소령.history.weekly = {};
  if (!data.중령.history.weekly) data.중령.history.weekly = {};
  if (!data.소령.users) data.소령.users = {};
  if (!data.중령.users) data.중령.users = {};
}

function saveData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getReportDate() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  if (now.getHours() < 2) now.setDate(now.getDate() - 1);
  return now.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getYesterdayDate() {
  return addDays(getReportDate(), -1);
}

function getSundayWeekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  const day = d.getUTCDay();
  return addDays(dateStr, -day);
}

function recomputeTotals(group) {
  for (const u of Object.values(group.users || {})) {
    let a = 0;
    let e = 0;
    if (u.daily) {
      for (const d of Object.values(u.daily)) {
        a += (d?.admin || 0);
        e += (d?.extra || 0);
      }
    }
    u.totalAdmin = a;
    u.totalExtra = e;
  }
}

function clearRolling7DaysExcludingCurrentWeek(group) {
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);
  const rangeStart = addDays(today, -7);
  const rangeEnd = thisWeekStart;

  if (rangeStart >= rangeEnd) {
    return { rangeStart, rangeEnd, clearedEntries: 0, nothingToClear: true };
  }

  let clearedEntries = 0;

  for (const u of Object.values(group.users || {})) {
    if (!u.daily) continue;
    for (const dateKey of Object.keys(u.daily)) {
      if (dateKey >= rangeStart && dateKey < rangeEnd) {
        delete u.daily[dateKey];
        clearedEntries++;
      }
    }
  }

  recomputeTotals(group);

  return { rangeStart, rangeEnd, clearedEntries, nothingToClear: false };
}

function calculate소령(input) {
  return (
    (input.권한지급 || 0) +
    (input.랭크변경 || 0) +
    (input.팀변경 || 0)
  );
}

function getExtra소령(input) {
  return (input.인게임시험 || 0) + (input.보직모집 || 0) * 2;
}

function calculate중령(input) {
  return (
    (input.인증 || 0) * 1.5 +
    (input.역할지급 || 0) +
    (input.감찰 || 0) * 2 +
    (input.서버역할 || 0) * 0.5
  );
}

function getExtra중령(input) {
  return (
    (input.인게임시험 || 0) +
    (input.코호스트 || 0) +
    (input.피드백 || 0) * 2
  );
}

function getAdminPointsByPercentile(pct) {
  if (pct <= 10) return 70;
  if (pct <= 34) return 50;
  if (pct <= 66) return 40;
  if (pct <= 90) return 30;
  return 20;
}

function buildDayScores(rankName, dateStr) {
  const is소령 = rankName === '소령';
  const minRequired = is소령 ? 3 : 4;
  const group = is소령 ? data.소령 : data.중령;

  const rows = Object.entries(group.users || {}).map(([userId, u]) => {
    const adminUnits = u?.daily?.[dateStr]?.admin ?? 0;
    const extraRaw = u?.daily?.[dateStr]?.extra ?? 0;
    const meetsMin = adminUnits >= minRequired;

    return {
      userId,
      nick: u?.nick || '알수없음',
      adminUnits,
      extraRaw,
      meetsMin,
      adminPoints: 0,
      extraPoints: 0,
      total: 0,
      percentile: null
    };
  });

  const eligible = rows.filter(r => r.meetsMin);
  eligible.sort((a, b) => b.adminUnits - a.adminUnits);

  const n = eligible.length;

  for (let i = 0; i < n; i++) {
    const cur = eligible[i];
    let start = i;
    while (start > 0 && eligible[start - 1].adminUnits === cur.adminUnits) start--;

    const rank = start + 1;
    const pct = Math.ceil((rank / n) * 100);

    cur.percentile = pct;
    cur.adminPoints = getAdminPointsByPercentile(pct);
    cur.extraPoints = Math.min(30, cur.extraRaw);
    cur.total = Math.min(100, cur.adminPoints + cur.extraPoints);
  }

  for (const r of rows) {
    if (!r.meetsMin) {
      r.adminPoints = 0;
      r.extraPoints = 0;
      r.total = 0;
      r.percentile = null;
    }
  }

  const display = [...rows].sort((a, b) => b.total - a.total);
  return { rows, display };
}

function makeDailySnapshot(rankName, dateStr) {
  const { display } = buildDayScores(rankName, dateStr);
  return display.map(r => ({
    userId: r.userId,
    nick: r.nick,
    total: r.total,
    adminPoints: r.adminPoints,
    extraPoints: r.extraPoints,
    percentile: r.percentile,
    meetsMin: r.meetsMin
  }));
}

function makeWeeklySnapshot(rankName, weekStart) {
  const is소령 = rankName === '소령';
  const group = is소령 ? data.소령 : data.중령;

  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const totals = {};

  for (const [uid, u] of Object.entries(group.users || {})) {
    totals[uid] = { userId: uid, nick: u?.nick || '알수없음', weeklyTotal: 0 };
  }

  for (const d of weekDates) {
    const { rows } = buildDayScores(rankName, d);
    rows.forEach(r => {
      if (!totals[r.userId]) totals[r.userId] = { userId: r.userId, nick: r.nick, weeklyTotal: 0 };
      totals[r.userId].weeklyTotal += r.total;
    });
  }

  const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal);
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    list
  };
}

function createDailyEmbedFromSnapshot(rankName, dateStr, snapshot) {
  const top = (snapshot || []).slice(0, 28);
  const lines = top.length
    ? top.map((r, i) => {
        const minText = r.meetsMin ? '' : ' (최소업무 미달)';
        const pctText = r.percentile ? ` / 상위 ${r.percentile}%` : '';
        return `**${i + 1}위** ${r.nick} — **${r.total}점** 〔행정: ${r.adminPoints}${pctText} / 추가: ${r.extraPoints}${minText}〕`;
      }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} ${dateStr} 점수 (최대 100점)`)
    .setDescription(lines);
}

function createTodayRankingEmbed(rankName) {
  const date = getReportDate();
  const { display } = buildDayScores(rankName, date);

  const top = display.slice(0, 28);
  const lines = top.length
    ? top.map((r, i) => {
        const minText = r.meetsMin ? '' : ' (최소업무 미달)';
        const pctText = r.percentile ? ` / 상위 ${r.percentile}%` : '';
        return `**${i + 1}위** ${r.nick} — **${r.total}점** 〔행정: ${r.adminPoints}${pctText} / 추가: ${r.extraPoints}${minText}〕`;
      }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} 오늘 점수 (최대 100점)`)
    .setDescription(`**일자**: ${date}\n\n${lines}`);
}

function createWeeklyEmbedFromSnapshot(rankName, weeklySnap) {
  if (!weeklySnap) {
    return new EmbedBuilder().setTitle(`${rankName} 지난주 점수`).setDescription('지난주 스냅샷이 없습니다.');
  }

  const list = (weeklySnap.list || []).slice(0, 28);
  const lines = list.length
    ? list.map((u, i) => `**${i + 1}위** ${u.nick} — **${u.weeklyTotal}점**`).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} 지난주 점수`)
    .setDescription(`**주간 범위**: ${weeklySnap.weekStart} ~ ${weeklySnap.weekEnd}\n\n${lines}`);
}

function createWeeklyRankingEmbed(rankName) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  const weekStart = group.weekStart || getSundayWeekStart(getReportDate());
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const totals = {};
  for (const [uid, u] of Object.entries(group.users || {})) {
    totals[uid] = { nick: u?.nick || '알수없음', weeklyTotal: 0 };
  }

  for (const d of weekDates) {
    const { rows } = buildDayScores(rankName, d);
    rows.forEach(r => {
      if (!totals[r.userId]) totals[r.userId] = { nick: r.nick, weeklyTotal: 0 };
      totals[r.userId].weeklyTotal += r.total;
    });
  }

  const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal).slice(0, 28);
  const lines = list.length
    ? list.map((u, i) => `**${i + 1}위** ${u.nick} — **${u.weeklyTotal}점**`).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} 주간 점수`)
    .setDescription(`**주간 범위**: ${weekStart} ~ ${addDays(weekStart, 6)}\n\n${lines}`);
}

function pruneOldDaily(keepDays) {
  const cutoff = addDays(getReportDate(), -keepDays);
  for (const group of [data.소령, data.중령]) {
    for (const u of Object.values(group.users || {})) {
      if (!u.daily) continue;
      for (const dateKey of Object.keys(u.daily)) {
        if (dateKey < cutoff) delete u.daily[dateKey];
      }
    }
    for (const dateKey of Object.keys(group.history.daily || {})) {
      if (dateKey < cutoff) delete group.history.daily[dateKey];
    }
  }
}

function pruneOldWeekly(keepWeeks) {
  const cutoff = addDays(getReportDate(), -(keepWeeks * 7));
  for (const group of [data.소령, data.중령]) {
    for (const k of Object.keys(group.history.weekly || {})) {
      if (k < cutoff) delete group.history.weekly[k];
    }
  }
}

function runDailyAutoReset() {
  const y = getYesterdayDate();
  data.소령.history.daily[y] = makeDailySnapshot('소령', y);
  data.중령.history.daily[y] = makeDailySnapshot('중령', y);
  pruneOldDaily(21);
  saveData();
}

function runWeeklyAutoReset() {
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);
  const lastWeekStart = addDays(thisWeekStart, -7);

  data.소령.history.weekly[lastWeekStart] = makeWeeklySnapshot('소령', lastWeekStart);
  data.중령.history.weekly[lastWeekStart] = makeWeeklySnapshot('중령', lastWeekStart);

  data.소령.lastWeekStart = lastWeekStart;
  data.중령.lastWeekStart = lastWeekStart;

  data.소령.weekStart = thisWeekStart;
  data.중령.weekStart = thisWeekStart;

  pruneOldWeekly(12);
  saveData();
}

function getOrMakeYesterdaySnapshot(rankName) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  const y = getYesterdayDate();
  let snap = group.history.daily[y];
  if (!snap) {
    snap = makeDailySnapshot(rankName, y);
    group.history.daily[y] = snap;
    saveData();
  }
  return { date: y, snap };
}

function getOrMakeLastWeekSnapshot(rankName) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  let key = group.lastWeekStart;
  if (!key) key = addDays(group.weekStart || getSundayWeekStart(getReportDate()), -7);

  let weeklySnap = group.history.weekly[key];
  if (!weeklySnap) {
    weeklySnap = makeWeeklySnapshot(rankName, key);
    group.history.weekly[key] = weeklySnap;
    group.lastWeekStart = key;
    saveData();
  }
  return weeklySnap;
}

async function registerCommands() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;

  const 소령Command = new SlashCommandBuilder()
    .setName('소령행정보고')
    .setDescription('소령 행정 보고서')
    .addStringOption(o => o.setName('닉네임').setDescription('닉네임').setRequired(true))
    .addIntegerOption(o => o.setName('권한지급').setDescription('권한 지급').setRequired(true))
    .addIntegerOption(o => o.setName('랭크변경').setDescription('랭크 변경').setRequired(true))
    .addIntegerOption(o => o.setName('팀변경').setDescription('팀 변경').setRequired(true))
    .addIntegerOption(o => o.setName('보직모집').setDescription('보직 모집').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험').setRequired(true));

  const 중령Command = new SlashCommandBuilder()
    .setName('중령행정보고')
    .setDescription('중령 행정 보고서')
    .addStringOption(o => o.setName('닉네임').setDescription('닉네임').setRequired(true))
    .addIntegerOption(o => o.setName('역할지급').setDescription('역할 지급').setRequired(true))
    .addIntegerOption(o => o.setName('인증').setDescription('인증').setRequired(true))
    .addIntegerOption(o => o.setName('서버역할').setDescription('서버 역할').setRequired(true))
    .addIntegerOption(o => o.setName('감찰').setDescription('감찰').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험').setRequired(true))
    .addIntegerOption(o => o.setName('코호스트').setDescription('코호스트').setRequired(true))
    .addIntegerOption(o => o.setName('피드백').setDescription('피드백').setRequired(true));

  await guild.commands.set([
    소령Command,
    중령Command,
    new SlashCommandBuilder().setName('소령오늘점수').setDescription('소령 오늘 점수'),
    new SlashCommandBuilder().setName('중령오늘점수').setDescription('중령 오늘 점수'),
    new SlashCommandBuilder().setName('소령주간점수').setDescription('소령 주간 점수'),
    new SlashCommandBuilder().setName('중령주간점수').setDescription('중령 주간 점수'),
    new SlashCommandBuilder().setName('어제점수').setDescription('어제 점수'),
    new SlashCommandBuilder().setName('지난주점수').setDescription('지난주 점수'),
    new SlashCommandBuilder().setName('초기화주간').setDescription('주간 초기화'),
    new SlashCommandBuilder().setName('행정통계').setDescription('행정 통계')
  ]);
}

client.once('ready', async () => {
  loadData();
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);

  if (!data.소령.weekStart) data.소령.weekStart = thisWeekStart;
  if (!data.중령.weekStart) data.중령.weekStart = thisWeekStart;
  saveData();

  await registerCommands();

  cron.schedule('0 2 * * *', () => runDailyAutoReset(), { timezone: 'Asia/Seoul' });
  cron.schedule('0 2 * * 0', () => runWeeklyAutoReset(), { timezone: 'Asia/Seoul' });
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  const hasRole = (roleId) => interaction.member?.roles?.cache?.has(roleId);
  const isSupervisor = () => interaction.member?.roles?.cache?.some(r => SUPERVISOR_ROLE_IDS.includes(r.id));
  const isMajor = () => hasRole(MAJOR_ROLE_ID);
  const isLtCol = () => hasRole(LTCOL_ROLE_ID);

  if (cmd === '소령행정보고' && !isMajor())
    return interaction.reply({ content: '소령 역할만 사용 가능', ephemeral: true });

  if (cmd === '중령행정보고' && !isLtCol())
    return interaction.reply({ content: '중령 역할만 사용 가능', ephemeral: true });

  if (cmd === '초기화주간' && !isSupervisor())
    return interaction.reply({ content: '감독관만 사용 가능', ephemeral: true });

  if (cmd === '초기화주간') {
    const today = getReportDate();
    const thisWeekStart = getSundayWeekStart(today);

    const majRes = clearRolling7DaysExcludingCurrentWeek(data.소령);
    const ltRes = clearRolling7DaysExcludingCurrentWeek(data.중령);

    data.소령.weekStart = thisWeekStart;
    data.중령.weekStart = thisWeekStart;

    pruneOldDaily(21);
    pruneOldWeekly(12);
    saveData();

    return interaction.reply({
      content:
        `초기화 완료\n` +
        `삭제 구간: ${majRes.rangeStart} ~ ${addDays(majRes.rangeEnd, -1)}\n` +
        `소령 ${majRes.clearedEntries} / 중령 ${ltRes.clearedEntries}`
    });
  }
});

if (!TOKEN) process.exit(1);
client.login(TOKEN);