// @ts-nocheck

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ================== 설정 ==================
const TOKEN = process.env.TOKEN;
const GUILD_ID = '1018194815286001756';

// ✅ 스프레드시트 ID (사용자 제공)
const SPREADSHEET_ID = '1EhC_xDBXR7mm7_KdVPp2dKPjNSKClcEEHIZT6ZPvfaQ';

// ✅ 모든 명령어 권한(역할 무시) 부여할 유저 ID들
const ADMIN_OVERRIDE_USER_IDS = [
  '1369378060557877480'
];

// ================== Railway용: 서비스계정 JSON을 env로 받아 파일로 생성 ==================
function ensureGoogleKeyFile() {
  const envJson = process.env.GOOGLE_SA_JSON;
  const filePath = process.env.GOOGLE_KEYFILE || path.join(__dirname, 'service-account.json');

  if (fs.existsSync(filePath)) return filePath;

  if (!envJson) {
    console.log('❌ GOOGLE_SA_JSON 환경변수가 없고, service-account.json 파일도 없습니다.');
    return filePath;
  }

  fs.writeFileSync(filePath, envJson, 'utf8');
  console.log(`✅ Google service account key written to: ${filePath}`);
  return filePath;
}

const GOOGLE_KEYFILE = ensureGoogleKeyFile();

// ✅ 구글 인증
const gAuth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function appendRowToSheet(rangeA1, values) {
  const sheets = google.sheets({ version: 'v4', auth: gAuth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: rangeA1,                     // 예: '소령!A:Z'
    valueInputOption: 'USER_ENTERED',   // ✅ 수식 가능
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] }
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ================== 역할 ID ==================
const SUPERVISOR_ROLE_IDS = [
  '1018195904261529691', // 감독관
  '1473688580613341419'  // 인사행정부단장
];

const MAJOR_ROLE_ID = '1472582859339596091';   // 소령
const LTCOL_ROLE_ID = '1018447060627894322';   // 중령

const EXCLUDED_ROLE_IDS = [
  '1018195904261529691', // 감독관
  '1463433369869090962', // 사령본부
  '1473688580613341419'  // 인사행정부단장
];

const DEMOTION_EXCLUDED_ROLE_IDS = [
  '1477394729808298167', // 법무교육단
  '1018195904261529691', // 감독관
  '1463433369869090962', // 사령본부
  '1473688580613341419'  // 인사행정부단장
];

const DEMOTION_ALLOWED_ROLE_IDS = [
  '1018195904261529691', // 감독관
  '1473688580613341419'  // 인사행정부단장
];

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'admin_data.json');

// ================== 데이터 구조 ==================
let data = {
  소령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' },
  중령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' }
};

// ================== 런타임 캐시 ==================
const dayTotalsCache = new Map(); // `${rankName}|${dateStr}` -> Map(userId->total)
const paginationSessions = new Map();

// ================== 데이터 저장 ==================
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
  if (!data.소령.lastWeekStart) data.소령.lastWeekStart = '';
  if (!data.중령.lastWeekStart) data.중령.lastWeekStart = '';
  if (!data.소령.users) data.소령.users = {};
  if (!data.중령.users) data.중령.users = {};

  dayTotalsCache.clear();
  paginationSessions.clear();
}

function saveData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ================== 날짜 (새벽 2시 기준) ==================
function getReportDate() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST
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
  const d = new Date(`${dateStr}T12:00:00+09:00`);
  const day = d.getUTCDay(); // 0=일
  return addDays(dateStr, -day);
}

// ================== 공용 유틸 ==================
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hasAnyRole(member, roleIds) {
  return member?.roles?.cache?.some(r => roleIds.includes(r.id));
}

function daysSinceJoined(member) {
  const joined = member?.joinedAt;
  if (!joined) return 9999;
  const diffMs = Date.now() - joined.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function getRankNameForMember(member) {
  const hasMajor = member.roles.cache.has(MAJOR_ROLE_ID);
  const hasLtCol = member.roles.cache.has(LTCOL_ROLE_ID);
  if (hasMajor) return '소령';
  if (hasLtCol) return '중령';
  return null;
}

function getAllDateKeysForRank(rankName) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  const set = new Set();
  for (const u of Object.values(group.users || {})) {
    for (const k of Object.keys(u?.daily || {})) set.add(k);
  }
  return Array.from(set).sort();
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

// ================== /초기화주간 ==================
function clearPrev7ReportDaysBeforeThisWeek(group) {
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);

  const rangeStart = addDays(thisWeekStart, -7);
  const rangeEnd = thisWeekStart;

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
  return { rangeStart, rangeEnd, clearedEntries, thisWeekStart, today };
}

// ================== 계산 함수 ==================
function calculate소령(input) {
  return (input.권한지급 || 0) * 1 + (input.랭크변경 || 0) * 1 + (input.팀변경 || 0) * 1;
}
function getExtra소령(input) {
  return (input.인게임시험 || 0) * 1 + (input.보직모집 || 0) * 2;
}

function calculate중령(input) {
  return (
    (input.인증 || 0) * 1.5 +
    (input.역할지급 || 0) * 1 +
    (input.감찰 || 0) * 2 +
    (input.서버역할 || 0) * 0.5
  );
}

// ✅ 중령 추가점수: 스카웃/모집(보직모집) 2점/건 포함
function getExtra중령(input) {
  return (
    (input.인게임시험 || 0) * 1 +
    (input.코호스트 || 0) * 1 +
    (input.피드백 || 0) * 2 +
    (input.보직모집 || 0) * 2
  );
}

function getTopPercentFromRank(rank, n) {
  if (n <= 1) return 1;
  return Math.round(((rank - 1) / (n - 1)) * 99) + 1;
}

function getAdminPointsByPercentile(pct) {
  if (pct <= 10) return 70;
  if (pct <= 34) return 50;
  if (pct <= 66) return 40;
  if (pct <= 90) return 30;
  return 20;
}

async function getEligibleMemberIdsByRank(guild, rankName) {
  const members = await guild.members.fetch();
  const requiredRole = rankName === '소령' ? MAJOR_ROLE_ID : LTCOL_ROLE_ID;

  const ids = [];
  for (const [, m] of members) {
    if (m.user?.bot) continue;
    if (!m.roles.cache.has(requiredRole)) continue;

    const excluded = m.roles.cache.some(r => EXCLUDED_ROLE_IDS.includes(r.id));
    if (excluded) continue;

    ids.push(m.id);
  }
  return ids;
}

function buildDayScoresForMembers(rankName, dateStr, memberIds) {
  const is소령 = rankName === '소령';
  const minRequired = is소령 ? 3 : 4;
  const group = is소령 ? data.소령 : data.중령;

  const rows = (memberIds || []).map((userId) => {
    const u = group.users?.[userId];
    const adminUnits = u?.daily?.[dateStr]?.admin ?? 0;
    const extraRaw = u?.daily?.[dateStr]?.extra ?? 0;
    const meetsMin = adminUnits >= minRequired;

    const nick = u?.nick || `<@${userId}>`;

    return {
      userId,
      nick,
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
    const pct = getTopPercentFromRank(rank, n);

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
  return { rows, display, dateStr };
}

function getDayTotalsOnly(rankName, dateStr) {
  const cacheKey = `${rankName}|${dateStr}`;
  const cached = dayTotalsCache.get(cacheKey);
  if (cached) return cached;

  const is소령 = rankName === '소령';
  const minRequired = is소령 ? 3 : 4;
  const group = is소령 ? data.소령 : data.중령;

  const rows = Object.entries(group.users || {}).map(([userId, u]) => {
    const adminUnits = u?.daily?.[dateStr]?.admin ?? 0;
    const extraRaw = u?.daily?.[dateStr]?.extra ?? 0;
    const meetsMin = adminUnits >= minRequired;
    return { userId, adminUnits, extraRaw, meetsMin };
  });

  const eligible = rows.filter(r => r.meetsMin);
  eligible.sort((a, b) => b.adminUnits - a.adminUnits);

  const n = eligible.length;
  const totalsMap = new Map();

  for (let i = 0; i < n; i++) {
    const cur = eligible[i];

    let start = i;
    while (start > 0 && eligible[start - 1].adminUnits === cur.adminUnits) start--;

    const rank = start + 1;
    const pct = getTopPercentFromRank(rank, n);

    const adminPoints = getAdminPointsByPercentile(pct);
    const extraPoints = Math.min(30, cur.extraRaw);
    const total = Math.min(100, adminPoints + extraPoints);

    totalsMap.set(cur.userId, total);
  }

  dayTotalsCache.set(cacheKey, totalsMap);
  return totalsMap;
}

// ================== 임베드/페이지네이션 ==================
function buildPagerComponents(rankName, mode, key, page, totalPages) {
  const prevDisabled = page <= 0;
  const nextDisabled = page >= totalPages - 1;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pg|${rankName}|${mode}|${key}|${page - 1}`)
      .setLabel('이전 페이지')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(prevDisabled),
    new ButtonBuilder()
      .setCustomId(`pg|${rankName}|${mode}|${key}|${page + 1}`)
      .setLabel('다음 페이지')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(nextDisabled)
  );

  return [row];
}

function createDailyEmbedPaged(rankName, dateStr, fullList, page, pageSize, titlePrefix) {
  const total = fullList.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = clamp(page, 0, totalPages - 1);

  const start = p * pageSize;
  const slice = fullList.slice(start, start + pageSize);

  const lines = slice.length
    ? slice.map((r, i) => {
      const rankNo = start + i + 1;
      const minText = r.meetsMin ? '' : ' (최소업무 미달)';
      const pctText = r.percentile ? ` / 상위 ${r.percentile}%` : '';
      return `**${rankNo}위** ${r.nick} — **${r.total}점** 〔행정: ${r.adminPoints}${pctText} / 추가: ${r.extraPoints}${minText}〕`;
    }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} ${titlePrefix} (${dateStr}) (최대 100점)`)
    .setDescription(lines)
    .setFooter({ text: `페이지 ${p + 1}/${totalPages} · 최소업무 미달자는 0점 + 퍼센트 산정에서 제외` });
}

function createWeeklyEmbedPaged(rankName, weekStart, weekEnd, fullList, page, pageSize, titlePrefix) {
  const total = fullList.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = clamp(page, 0, totalPages - 1);

  const start = p * pageSize;
  const slice = fullList.slice(start, start + pageSize);

  const lines = slice.length
    ? slice.map((u, i) => {
      const rankNo = start + i + 1;
      return `**${rankNo}위** ${u.nick} — **${u.weeklyTotal}점**`;
    }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} ${titlePrefix}`)
    .setDescription(`**주간 범위(새벽 2시 기준)**: ${weekStart} ~ ${weekEnd} (7일)\n\n${lines}`)
    .setFooter({ text: `페이지 ${p + 1}/${totalPages} · 주간=일~토(7일) 합산 / 일일 행정점수는 퍼센트 기준` });
}

function createDemotionEmbed(list, page, pageSize, totalPages) {
  const start = page * pageSize;
  const slice = list.slice(start, start + pageSize);

  const lines = slice.length
    ? slice.map((x, i) => {
      const rankNo = start + i + 1;
      return `**${rankNo}위** ${x.mention} — **총합 ${x.totalScore}점** 〔${x.rankName}〕`;
    }).join('\n')
    : '대상이 없습니다.';

  return new EmbedBuilder()
    .setTitle('강등 대상 (총합 150점 미만)')
    .setDescription(lines)
    .setFooter({ text: `페이지 ${page + 1}/${totalPages} · 가입 7일 미만/제외 역할 보유자는 제외됨` });
}

function buildDemotionComponents(page, totalPages) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dg|${page - 1}`)
        .setLabel('이전 페이지')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`dg|${page + 1}`)
        .setLabel('다음 페이지')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    )
  ];
}

// ================== 자동 초기화 ==================
function pruneOldDaily(keepDays) {
  const cutoff = addDays(getReportDate(), -keepDays);

  const pruneUserDaily = (group) => {
    for (const u of Object.values(group.users || {})) {
      if (!u.daily) continue;
      for (const dateKey of Object.keys(u.daily)) {
        if (dateKey < cutoff) delete u.daily[dateKey];
      }
    }
  };

  pruneUserDaily(data.소령);
  pruneUserDaily(data.중령);

  for (const dateKey of Object.keys(data.소령.history.daily || {})) {
    if (dateKey < cutoff) delete data.소령.history.daily[dateKey];
  }
  for (const dateKey of Object.keys(data.중령.history.daily || {})) {
    if (dateKey < cutoff) delete data.중령.history.daily[dateKey];
  }

  dayTotalsCache.clear();
}

function pruneOldWeekly(keepWeeks) {
  const cutoff = addDays(getReportDate(), -(keepWeeks * 7));
  for (const k of Object.keys(data.소령.history.weekly || {})) {
    if (k < cutoff) delete data.소령.history.weekly[k];
  }
  for (const k of Object.keys(data.중령.history.weekly || {})) {
    if (k < cutoff) delete data.중령.history.weekly[k];
  }
}

function makeDailySnapshot(rankName, dateStr) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  const ids = Object.keys(group.users || {});
  const { display } = buildDayScoresForMembers(rankName, dateStr, ids);
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
    totals[uid] = { userId: uid, nick: u?.nick || `<@${uid}>`, weeklyTotal: 0 };
  }

  for (const d of weekDates) {
    const totalsMap = getDayTotalsOnly(rankName, d);
    for (const [uid, t] of totalsMap.entries()) {
      if (!totals[uid]) totals[uid] = { userId: uid, nick: group.users?.[uid]?.nick || `<@${uid}>`, weeklyTotal: 0 };
      totals[uid].weeklyTotal += t;
    }
  }

  const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal);
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    list: list.map(x => ({ userId: x.userId, nick: x.nick, weeklyTotal: x.weeklyTotal }))
  };
}

function runDailyAutoReset() {
  const y = getYesterdayDate();
  data.소령.history.daily[y] = makeDailySnapshot('소령', y);
  data.중령.history.daily[y] = makeDailySnapshot('중령', y);

  pruneOldDaily(21);
  saveData();
  console.log(`🧹 어제 스냅샷 저장 완료 (${y})`);
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
  console.log(`🔄 주간 초기화 완료 (weekStart=${thisWeekStart}, lastWeekStart=${lastWeekStart})`);
}

// ================== 명령어 등록 ==================
async function registerCommands() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return console.log('서버를 찾을 수 없습니다.');

  const 소령Command = new SlashCommandBuilder()
    .setName('소령행정보고').setDescription('소령 행정 보고서 (소령 전용)')
    .addIntegerOption(o => o.setName('권한지급').setDescription('권한 지급 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('랭크변경').setDescription('랭크 변경 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('팀변경').setDescription('팀 변경 : n건').setRequired(true))
    // ✅ 표시 문구: 스카웃/모집
    .addIntegerOption(o => o.setName('보직모집').setDescription('스카웃/모집 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    소령Command.addAttachmentOption(o =>
      o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false)
    );
  }

  const 중령Command = new SlashCommandBuilder()
    .setName('중령행정보고').setDescription('중령 행정 보고서 (중령 전용)')
    .addIntegerOption(o => o.setName('역할지급').setDescription('역할 지급 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인증').setDescription('인증 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('서버역할').setDescription('서버 역할 요청 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('감찰').setDescription('행정 감찰 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('코호스트').setDescription('인게임 코호스트 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('피드백').setDescription('피드백 제공 : n건').setRequired(true))
    // ✅ 표시 문구: 스카웃/모집
    .addIntegerOption(o => o.setName('보직모집').setDescription('스카웃/모집 : n건').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    중령Command.addAttachmentOption(o =>
      o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false)
    );
  }

  const 소령오늘초기화 = new SlashCommandBuilder()
    .setName('소령오늘초기화')
    .setDescription('소령 오늘 기록 초기화 (감독관) - 특정 유저 또는 전체')
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 유저를 오늘 기록 초기화').setRequired(false));

  const 중령오늘초기화 = new SlashCommandBuilder()
    .setName('중령오늘초기화')
    .setDescription('중령 오늘 기록 초기화 (감독관) - 특정 유저 또는 전체')
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 유저를 오늘 기록 초기화').setRequired(false));

  await guild.commands.set([
    소령Command, 중령Command,

    new SlashCommandBuilder().setName('소령오늘점수').setDescription('소령 오늘 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령오늘점수').setDescription('중령 오늘 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('소령주간점수').setDescription('소령 주간 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령주간점수').setDescription('중령 주간 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('소령어제점수').setDescription('소령 어제 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령어제점수').setDescription('중령 어제 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('소령지난주점수').setDescription('소령 지난주 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령지난주점수').setDescription('중령 지난주 점수 (감독관 전용)'),

    new SlashCommandBuilder().setName('어제점수').setDescription('소령/중령 어제 점수 한 번에 보기 (감독관 전용)'),
    new SlashCommandBuilder().setName('지난주점수').setDescription('소령/중령 지난주 점수 한 번에 보기 (감독관 전용)'),

    소령오늘초기화,
    중령오늘초기화,
    new SlashCommandBuilder().setName('초기화주간').setDescription('주간 전체 초기화 (감독관)'),
    new SlashCommandBuilder().setName('행정통계').setDescription('전체 통계 (감독관)'),

    new SlashCommandBuilder().setName('강등대상').setDescription('총합 점수 150점 미만 강등 대상 조회 (감독관/인사행정부단장)')
  ]);

  console.log('✅ 명령어 등록 완료');
}

// ================== ready ==================
client.once('ready', async () => {
  console.log(`${client.user.tag} 준비 완료!`);
  loadData();

  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);

  if (!data.소령.weekStart) data.소령.weekStart = thisWeekStart;
  if (!data.중령.weekStart) data.중령.weekStart = thisWeekStart;
  saveData();

  if (!fs.existsSync(GOOGLE_KEYFILE)) {
    console.log(`⚠️ GOOGLE KEYFILE을 찾을 수 없습니다: ${GOOGLE_KEYFILE}`);
    console.log('   Railway Variables에 GOOGLE_SA_JSON을 추가했는지 확인하세요.');
  }

  await registerCommands();

  cron.schedule('0 2 * * *', () => runDailyAutoReset(), { timezone: 'Asia/Seoul' });
  cron.schedule('0 2 * * 0', () => runWeeklyAutoReset(), { timezone: 'Asia/Seoul' });

  console.log('⏰ 자동 스냅샷/초기화 스케줄 등록 완료 (매일 02:00 / 매주 일 02:00)');
});

// ================== interactionCreate ==================
client.on('interactionCreate', async interaction => {
  // 버튼 처리
  if (interaction.isButton()) {
    const customId = interaction.customId || '';

    // ✅ “모든 권한” 유저는 버튼도 전부 허용
    const isOverrideUser = ADMIN_OVERRIDE_USER_IDS.includes(interaction.user.id);

    if (customId.startsWith('pg|')) {
      const isSupervisor = () =>
        isOverrideUser ||
        interaction.member?.roles?.cache?.some(r => SUPERVISOR_ROLE_IDS.includes(r.id));

      if (!isSupervisor()) return interaction.reply({ content: '❌ 감독관만 사용할 수 있습니다.', ephemeral: true });

      const parts = customId.split('|');
      const rankName = parts[1];
      const mode = parts[2];
      const key = parts[3];
      const page = parseInt(parts[4], 10) || 0;

      const msgId = interaction.message?.id;
      const session = msgId ? paginationSessions.get(msgId) : null;

      if (!session || session.rankName !== rankName || session.mode !== mode || session.key !== key) {
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

        const memberIds = await getEligibleMemberIdsByRank(guild, rankName);
        let newSession = null;

        if (mode === 'today' || mode === 'yesterday') {
          const dateStr = key;
          const { display } = buildDayScoresForMembers(rankName, dateStr, memberIds);
          newSession = { rankName, mode, key: dateStr, list: display, pageSize: 28 };
        } else if (mode === 'week' || mode === 'lastweek') {
          const weekStart = key;
          const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
          const group = rankName === '소령' ? data.소령 : data.중령;

          const totals = {};
          for (const uid of memberIds) totals[uid] = { userId: uid, nick: group.users?.[uid]?.nick || `<@${uid}>`, weeklyTotal: 0 };

          for (const d of weekDates) {
            const totalsMap = getDayTotalsOnly(rankName, d);
            for (const uid of memberIds) totals[uid].weeklyTotal += (totalsMap.get(uid) || 0);
          }

          const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal);
          newSession = { rankName, mode, key: weekStart, list, pageSize: 28 };
        }

        if (!newSession) return interaction.reply({ content: '❌ 페이지 정보를 처리할 수 없습니다.', ephemeral: true });
        paginationSessions.set(msgId, newSession);
      }

      const s = paginationSessions.get(msgId);
      const pageSize = s.pageSize || 28;

      if (s.mode === 'today' || s.mode === 'yesterday') {
        const dateStr = s.key;
        const totalPages = Math.max(1, Math.ceil(s.list.length / pageSize));
        const p = clamp(page, 0, totalPages - 1);

        const titlePrefix = s.mode === 'today' ? '오늘 점수' : '어제 점수';
        const embed = createDailyEmbedPaged(rankName, dateStr, s.list, p, pageSize, titlePrefix);
        const components = buildPagerComponents(rankName, s.mode, s.key, p, totalPages);

        return interaction.update({ embeds: [embed], components });
      }

      if (s.mode === 'week' || s.mode === 'lastweek') {
        const weekStart = s.key;
        const weekEnd = addDays(weekStart, 6);

        const totalPages = Math.max(1, Math.ceil(s.list.length / pageSize));
        const p = clamp(page, 0, totalPages - 1);

        const titlePrefix = s.mode === 'week' ? '주간 점수' : '지난주 점수';
        const embed = createWeeklyEmbedPaged(rankName, weekStart, weekEnd, s.list, p, pageSize, titlePrefix);
        const components = buildPagerComponents(rankName, s.mode, s.key, p, totalPages);

        return interaction.update({ embeds: [embed], components });
      }

      return;
    }

    if (customId.startsWith('dg|')) {
      const allowed =
        isOverrideUser ||
        hasAnyRole(interaction.member, DEMOTION_ALLOWED_ROLE_IDS);

      if (!allowed) return interaction.reply({ content: '❌ 감독관 또는 인사행정부단장만 사용할 수 있습니다.', ephemeral: true });

      const page = parseInt(customId.split('|')[1], 10) || 0;
      const msgId = interaction.message?.id;
      const session = msgId ? paginationSessions.get(msgId) : null;

      if (!session || session.mode !== 'demotion') {
        return interaction.reply({ content: 'ℹ️ 페이지 세션이 만료되었습니다. /강등대상 명령어를 다시 실행하세요.', ephemeral: true });
      }

      const pageSize = session.pageSize || 28;
      const list = session.list || [];
      const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
      const p = clamp(page, 0, totalPages - 1);

      const embed = createDemotionEmbed(list, p, pageSize, totalPages);
      const components = buildDemotionComponents(p, totalPages);

      return interaction.update({ embeds: [embed], components });
    }

    return;
  }

  // 슬래시
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  const isOverrideUser = ADMIN_OVERRIDE_USER_IDS.includes(interaction.user.id);

  const hasRole = (roleId) => interaction.member?.roles?.cache?.has(roleId);

  // ✅ “모든 권한” 유저는 감독관/소령/중령 역할 체크를 전부 통과
  const isSupervisor = () =>
    isOverrideUser ||
    interaction.member?.roles?.cache?.some(r => SUPERVISOR_ROLE_IDS.includes(r.id));

  const isMajor = () => isOverrideUser || hasRole(MAJOR_ROLE_ID);
  const isLtCol = () => isOverrideUser || hasRole(LTCOL_ROLE_ID);

  // 역할 제한 (override 유저는 통과)
  if (cmd === '소령행정보고' && !isMajor()) return interaction.reply({ content: '❌ 이 명령어는 **소령 역할**만 사용할 수 있습니다.', ephemeral: true });
  if (cmd === '중령행정보고' && !isLtCol()) return interaction.reply({ content: '❌ 이 명령어는 **중령 역할**만 사용할 수 있습니다.', ephemeral: true });

  // ================== ✅ 행정보고 ==================
  if (cmd === '소령행정보고' || cmd === '중령행정보고') {
    const is소령 = cmd === '소령행정보고';
    const date = getReportDate();

    // ✅ 디스코드 표시: 자동 멘션
    const mention = `<@${interaction.user.id}>`;

    // ✅ 시트/로컬 저장: 실제 닉네임(displayName)
    const displayName = interaction.member?.displayName || interaction.user.username;

    let replyText =
      `✅ **${is소령 ? '소령' : '중령'} 보고 완료!**\n` +
      `**닉네임**: ${mention}\n` +
      `**일자**: ${date}\n\n`;

    let adminCount = 0, extra = 0;
    let input = null;

    if (is소령) {
      input = {
        권한지급: interaction.options.getInteger('권한지급'),
        랭크변경: interaction.options.getInteger('랭크변경'),
        팀변경: interaction.options.getInteger('팀변경'),
        보직모집: interaction.options.getInteger('보직모집'),
        인게임시험: interaction.options.getInteger('인게임시험')
      };

      adminCount = calculate소령(input);
      extra = getExtra소령(input);

      replyText += `**권한지급**: ${input.권한지급}건\n`;
      replyText += `**랭크변경**: ${input.랭크변경}건\n`;
      replyText += `**팀변경**: ${input.팀변경}건\n`;
      replyText += `**스카웃/모집**: ${input.보직모집}건\n`;
      replyText += `**인게임 시험**: ${input.인게임시험}건\n`;
    } else {
      input = {
        역할지급: interaction.options.getInteger('역할지급'),
        인증: interaction.options.getInteger('인증'),
        서버역할: interaction.options.getInteger('서버역할'),
        감찰: interaction.options.getInteger('감찰'),
        인게임시험: interaction.options.getInteger('인게임시험'),
        코호스트: interaction.options.getInteger('코호스트'),
        피드백: interaction.options.getInteger('피드백'),
        보직모집: interaction.options.getInteger('보직모집')
      };

      adminCount = calculate중령(input);
      extra = getExtra중령(input);

      replyText += `**역할지급**: ${input.역할지급}건\n`;
      replyText += `**인증 처리**: ${input.인증}건\n`;
      replyText += `**서버 역할 요청**: ${input.서버역할}건\n`;
      replyText += `**행정 감찰**: ${input.감찰}건\n`;
      replyText += `**인게임 시험**: ${input.인게임시험}건\n`;
      replyText += `**인게임 코호스트**: ${input.코호스트}건\n`;
      replyText += `**피드백 제공**: ${input.피드백}건\n`;
      replyText += `**스카웃/모집**: ${input.보직모집}건\n`;
    }

    // 사진
    const photoAttachments = [];
    for (let i = 1; i <= 10; i++) {
      const att = interaction.options.getAttachment(`증거사진${i}`);
      if (att) photoAttachments.push(att);
    }
    if (photoAttachments.length > 0) replyText += `\n📸 증거 사진 ${photoAttachments.length}장 첨부됨`;

    // 로컬 저장(닉네임은 displayName으로 유지)
    const group = is소령 ? data.소령 : data.중령;
    if (!group.users[interaction.user.id]) group.users[interaction.user.id] = { nick: displayName, totalAdmin: 0, totalExtra: 0, daily: {} };
    const u = group.users[interaction.user.id];
    u.nick = displayName;

    if (!u.daily[date]) u.daily[date] = { admin: 0, extra: 0 };
    u.daily[date].admin += adminCount;
    u.daily[date].extra += extra;
    u.totalAdmin += adminCount;
    u.totalExtra += extra;

    dayTotalsCache.delete(`${is소령 ? '소령' : '중령'}|${date}`);
    saveData();

    // ================== ✅ 구글 시트 저장 (증거사진은 저장하지 않음) ==================
    try {
      if (is소령) {
        await appendRowToSheet('소령!A:K', [
          date,
          displayName,
          input.권한지급,
          input.랭크변경,
          input.팀변경,
          `=INDEX(C:C,ROW())+INDEX(D:D,ROW())+INDEX(E:E,ROW())`,
          input.보직모집,
          input.인게임시험
        ]);
      } else {
        await appendRowToSheet('중령!A:K', [
          date,
          displayName,
          input.역할지급,
          input.인증,
          input.서버역할,
          input.감찰,
          `=INDEX(C:C,ROW())+INDEX(D:D,ROW())+INDEX(E:E,ROW())+INDEX(F:F,ROW())`,
          input.인게임시험,
          input.코호스트,
          input.피드백,
          input.보직모집
        ]);
      }
    } catch (e) {
      console.error('❌ 구글시트 저장 실패:', e);
      replyText += `\n\n⚠️ 구글 시트 자동 기입에 실패했습니다. Railway Logs를 확인하세요.`;
    }

    // 디스코드 응답(사진 첨부 유지)
    let embeds = [];
    let files = [];

    if (photoAttachments.length > 0) {
      files = photoAttachments.slice(0, 10).map((att, idx) => ({
        attachment: att.url,
        name: `evidence_${idx + 1}_${att.name || 'image.png'}`
      }));

      const links = photoAttachments
        .slice(0, 10)
        .map((att, idx) => `[[사진${idx + 1}]](${att.url})`)
        .join('  •  ');

      embeds = [new EmbedBuilder().setTitle('📸 증거 사진').setDescription(links)];
    }

    await interaction.reply({ content: replyText, embeds, files, ephemeral: false });
    return;
  }

  // ================== 감독관 전용(override 유저는 통과) ==================
  const supervisorOnlyCmds = new Set([
    '소령오늘점수', '소령주간점수', '소령어제점수', '소령지난주점수',
    '중령오늘점수', '중령주간점수', '중령어제점수', '중령지난주점수',
    '어제점수', '지난주점수',
    '초기화주간', '소령오늘초기화', '중령오늘초기화',
    '행정통계'
  ]);

  if (supervisorOnlyCmds.has(cmd) && !isSupervisor()) {
    return interaction.reply({ content: '❌ 감독관만 사용할 수 있습니다.', ephemeral: true });
  }

  const guild = interaction.guild;

  async function replyDailyPaged(rankName, dateStr, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const memberIds = await getEligibleMemberIdsByRank(guild, rankName);
    const { display } = buildDayScoresForMembers(rankName, dateStr, memberIds);

    const pageSize = 28;
    const page = 0;
    const totalPages = Math.max(1, Math.ceil(display.length / pageSize));

    const titlePrefix = mode === 'today' ? '오늘 점수' : mode === 'yesterday' ? '어제 점수' : '점수';
    const embed = createDailyEmbedPaged(rankName, dateStr, display, page, pageSize, titlePrefix);
    const components = buildPagerComponents(rankName, mode, dateStr, page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { rankName, mode, key: dateStr, list: display, pageSize });
  }

  async function replyWeeklyPaged(rankName, weekStart, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const memberIds = await getEligibleMemberIdsByRank(guild, rankName);

    const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const weekEnd = addDays(weekStart, 6);

    const group = rankName === '소령' ? data.소령 : data.중령;

    const totals = {};
    for (const uid of memberIds) totals[uid] = { userId: uid, nick: group.users?.[uid]?.nick || `<@${uid}>`, weeklyTotal: 0 };

    for (const d of weekDates) {
      const totalsMap = getDayTotalsOnly(rankName, d);
      for (const uid of memberIds) totals[uid].weeklyTotal += (totalsMap.get(uid) || 0);
    }

    const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal);

    const pageSize = 28;
    const page = 0;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));

    const titlePrefix = mode === 'week' ? '주간 점수' : '지난주 점수';
    const embed = createWeeklyEmbedPaged(rankName, weekStart, weekEnd, list, page, pageSize, titlePrefix);
    const components = buildPagerComponents(rankName, mode, weekStart, page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { rankName, mode, key: weekStart, list, pageSize });
  }

  if (cmd === '소령오늘점수') return replyDailyPaged('소령', getReportDate(), 'today');
  if (cmd === '중령오늘점수') return replyDailyPaged('중령', getReportDate(), 'today');

  if (cmd === '소령주간점수') {
    const weekStart = data.소령.weekStart || getSundayWeekStart(getReportDate());
    return replyWeeklyPaged('소령', weekStart, 'week');
  }
  if (cmd === '중령주간점수') {
    const weekStart = data.중령.weekStart || getSundayWeekStart(getReportDate());
    return replyWeeklyPaged('중령', weekStart, 'week');
  }

  if (cmd === '소령어제점수') return replyDailyPaged('소령', getYesterdayDate(), 'yesterday');
  if (cmd === '중령어제점수') return replyDailyPaged('중령', getYesterdayDate(), 'yesterday');

  if (cmd === '소령지난주점수') {
    const thisWeekStart = data.소령.weekStart || getSundayWeekStart(getReportDate());
    const lastWeekStart = data.소령.lastWeekStart || addDays(thisWeekStart, -7);
    return replyWeeklyPaged('소령', lastWeekStart, 'lastweek');
  }
  if (cmd === '중령지난주점수') {
    const thisWeekStart = data.중령.weekStart || getSundayWeekStart(getReportDate());
    const lastWeekStart = data.중령.lastWeekStart || addDays(thisWeekStart, -7);
    return replyWeeklyPaged('중령', lastWeekStart, 'lastweek');
  }

  if (cmd === '강등대상') {
    const allowed =
      isOverrideUser ||
      hasAnyRole(interaction.member, DEMOTION_ALLOWED_ROLE_IDS);

    if (!allowed) return interaction.reply({ content: '❌ 감독관 또는 인사행정부단장만 사용할 수 있습니다.', ephemeral: true });
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const members = await guild.members.fetch();

    const eligible = [];
    for (const [, m] of members) {
      if (m.user?.bot) continue;

      const rankName = getRankNameForMember(m);
      if (!rankName) continue;

      if (daysSinceJoined(m) < 7) continue;
      if (hasAnyRole(m, DEMOTION_EXCLUDED_ROLE_IDS)) continue;

      eligible.push({ member: m, rankName });
    }

    const majorIds = eligible.filter(x => x.rankName === '소령').map(x => x.member.id);
    const ltcolIds = eligible.filter(x => x.rankName === '중령').map(x => x.member.id);

    const majorDates = getAllDateKeysForRank('소령');
    const ltcolDates = getAllDateKeysForRank('중령');

    const totals = new Map();
    for (const uid of majorIds) totals.set(uid, { totalScore: 0, rankName: '소령' });
    for (const uid of ltcolIds) totals.set(uid, { totalScore: 0, rankName: '중령' });

    for (const d of majorDates) {
      const dayTotals = getDayTotalsOnly('소령', d);
      for (const uid of majorIds) totals.get(uid).totalScore += (dayTotals.get(uid) || 0);
    }
    for (const d of ltcolDates) {
      const dayTotals = getDayTotalsOnly('중령', d);
      for (const uid of ltcolIds) totals.get(uid).totalScore += (dayTotals.get(uid) || 0);
    }

    const list = [];
    for (const { member, rankName } of eligible) {
      const t = totals.get(member.id);
      const totalScore = t?.totalScore ?? 0;

      if (totalScore < 150) {
        list.push({ userId: member.id, mention: `<@${member.id}>`, rankName, totalScore });
      }
    }

    list.sort((a, b) => a.totalScore - b.totalScore);

    const pageSize = 28;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    const page = 0;

    const embed = createDemotionEmbed(list, page, pageSize, totalPages);
    const components = buildDemotionComponents(page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { mode: 'demotion', list, pageSize });
    return;
  }

  if (cmd === '어제점수') {
    const dateStr = getYesterdayDate();
    const embed = new EmbedBuilder()
      .setTitle(`어제 점수 (기준일: ${dateStr})`)
      .setDescription('※ 공용 명령은 현재 “요약 안내”만 유지 중입니다.');
    return interaction.reply({ embeds: [embed] });
  }

  if (cmd === '지난주점수') {
    const embed = new EmbedBuilder()
      .setTitle('지난주 점수')
      .setDescription('※ 공용 명령은 현재 “요약 안내”만 유지 중입니다.');
    return interaction.reply({ embeds: [embed] });
  }

  if (cmd === '초기화주간') {
    const majRes = clearPrev7ReportDaysBeforeThisWeek(data.소령);
    const ltRes = clearPrev7ReportDaysBeforeThisWeek(data.중령);

    data.소령.weekStart = majRes.thisWeekStart;
    data.중령.weekStart = ltRes.thisWeekStart;

    pruneOldDaily(21);
    pruneOldWeekly(12);

    dayTotalsCache.clear();
    paginationSessions.clear();
    saveData();

    const endShown = addDays(majRes.rangeEnd, -1);

    return interaction.reply({
      content:
        `🔄 주간 초기화 완료 (일요일 02시 기준)\n` +
        `- 오늘(reportDate): ${majRes.today}\n` +
        `- 보호(이번 주): ${majRes.thisWeekStart} 02:00 이후 ~ 현재\n` +
        `- 삭제 구간(reportDate 7일): ${majRes.rangeStart} ~ ${endShown}\n` +
        `- 삭제된 daily 항목 수: 소령 ${majRes.clearedEntries} / 중령 ${ltRes.clearedEntries}\n` +
        `※ 일요일 02:00 이전(00:00~01:59) 보고는 reportDate가 전날로 저장되어 위 삭제 구간에 포함되어 삭제됩니다.`,
      ephemeral: false
    });
  }

  if (cmd === '소령오늘초기화' || cmd === '중령오늘초기화') {
    const is소령 = cmd === '소령오늘초기화';
    const date = getReportDate();
    const group = is소령 ? data.소령 : data.중령;

    const targetUser = interaction.options.getUser('대상');
    const isAll = interaction.options.getBoolean('전체') === true;

    if (!isAll && !targetUser) return interaction.reply({ content: 'ℹ️ 대상 또는 전체(true)를 선택하세요.', ephemeral: true });

    let cleared = 0;

    if (isAll) {
      for (const uid of Object.keys(group.users || {})) {
        const u = group.users[uid];
        if (u?.daily?.[date]) {
          delete u.daily[date];
          cleared++;
        }
      }

      recomputeTotals(group);
      dayTotalsCache.delete(`${is소령 ? '소령' : '중령'}|${date}`);
      paginationSessions.clear();
      saveData();

      return interaction.reply({ content: `✅ 오늘(${date}) 기록 전체 초기화 완료 (${cleared}명)`, ephemeral: false });
    }

    const uid = targetUser.id;
    const u = group.users?.[uid];
    if (!u?.daily?.[date]) return interaction.reply({ content: `ℹ️ ${targetUser} 님은 오늘(${date}) 기록이 없습니다.`, ephemeral: true });

    delete u.daily[date];
    recomputeTotals(group);

    dayTotalsCache.delete(`${is소령 ? '소령' : '중령'}|${date}`);
    paginationSessions.clear();
    saveData();

    return interaction.reply({ content: `✅ ${targetUser} 님의 오늘(${date}) 기록을 초기화했습니다.`, ephemeral: false });
  }

  if (cmd === '행정통계') {
    const date = getReportDate();

    const sumGroup = (group) => {
      let userCount = 0;
      let totalAdmin = 0;
      let totalExtra = 0;
      let todayAdminUnits = 0;
      let todayExtra = 0;

      for (const u of Object.values(group.users || {})) {
        userCount++;
        totalAdmin += (u.totalAdmin || 0);
        totalExtra += (u.totalExtra || 0);

        const d = u.daily?.[date];
        if (d) {
          todayAdminUnits += (d.admin || 0);
          todayExtra += (d.extra || 0);
        }
      }
      return { userCount, totalAdmin, totalExtra, todayAdminUnits, todayExtra };
    };

    const sMaj = sumGroup(data.소령);
    const sLt = sumGroup(data.중령);

    const embed = new EmbedBuilder()
      .setTitle('행정 통계(원자료)')
      .setDescription(
        `**기준 일자(새벽 2시 기준)**: ${date}\n\n` +
        `## 소령\n` +
        `- 등록 인원: ${sMaj.userCount}명\n` +
        `- 누적(원자료): 행정(건수) ${sMaj.totalAdmin} / 추가(점수) ${sMaj.totalExtra}\n` +
        `- 오늘(원자료): 행정(건수) ${sMaj.todayAdminUnits} / 추가(점수) ${sMaj.todayExtra}\n\n` +
        `## 중령\n` +
        `- 등록 인원: ${sLt.userCount}명\n` +
        `- 누적(원자료): 행정(건수) ${sLt.totalAdmin} / 추가(점수) ${sLt.totalExtra}\n` +
        `- 오늘(원자료): 행정(건수) ${sLt.todayAdminUnits} / 추가(점수) ${sLt.todayExtra}\n\n` +
        `※ "점수"는 퍼센트 환산 후 계산됩니다.`
      );

    return interaction.reply({ embeds: [embed] });
  }
});

// ================== TOKEN 체크 ==================
if (!TOKEN) {
  console.log('❌ TOKEN이 설정되지 않았습니다! Railway Variables의 TOKEN 확인');
  process.exit(1);
}

client.login(TOKEN);

/*
================== 적용 사항 ==================

[모든 명령어 권한]
- ADMIN_OVERRIDE_USER_IDS에 등록된 유저(예: 1369378060557877480)는
  - 소령/중령 역할 없이도 /소령행정보고, /중령행정보고 사용 가능
  - 감독관 역할 없이도 감독관 전용 명령/버튼(pg|, dg|) 포함 전부 사용 가능

[표시 문구 변경]
- /소령행정보고, /중령행정보고 옵션 설명: "스카웃/모집"
- 보고 완료 메시지 출력: "스카웃/모집"
(옵션 key는 그대로 '보직모집' 사용)

[구글 시트 - 컬럼]
(1) 소령 탭
- A: 일자
- B: 닉네임(displayName)
- C: 권한지급
- D: 랭크변경
- E: 팀변경
- F: 총 행정 건수 (=C+D+E)
- G: 스카웃/모집(보직모집)
- H: 인게임시험

(2) 중령 탭
- A: 일자
- B: 닉네임(displayName)
- C: 역할지급
- D: 인증
- E: 서버역할
- F: 감찰
- G: 총 행정 건수 (=C+D+E+F)
- H: 인게임시험
- I: 코호스트
- J: 피드백
- K: 스카웃/모집(보직모집)

※ 시트 탭 이름은 반드시 '소령', '중령' 이어야 합니다.
*/
