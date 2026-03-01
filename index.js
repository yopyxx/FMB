// @ts-nocheck
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
} = require('discord.js');

/* =========================
 * 0) CONFIG
 * ========================= */
const CONFIG = {
  TOKEN: process.env.TOKEN,
  GUILD_ID: '1018194815286001756',

  // Supervisor roles
  SUPERVISOR_ROLE_IDS: ['1018195904261529691', '1473688580613341419'],

  // Rank roles
  MAJOR_ROLE_ID: '1472582859339596091',     // 소령
  LTCOL_ROLE_ID: '1018447060627894322',     // 중령

  // 오늘/주간 점수에서 "보고 안 해도 포함" 기준(랭크별로 변경!)
  INCLUDE_ROLE_BY_RANK: {
    소령: '1472582859339596091',          // ✅ 소령 role
    중령: '1018447060627894322',          // ✅ 중령 role
  },

  // 강등대상 후보 풀(반드시 포함되어야 하는 역할)
  DEMOTION_INCLUDE_ROLE_ID: '1018195906807480402',

  // 강등대상 제외 역할(추가 2개 포함)
  DEMOTION_EXCLUDE_ROLE_IDS: [
    '1477394729808298167',
    '1018195904261529691',
    '1463433369869090962',
  ],

  PAGE_SIZE: 28,
  DEMOTION_THRESHOLD: 150,
  CACHE_TTL_MS: 15 * 60 * 1000,

  DATA_DIR: path.join(__dirname, 'data'),
  DATA_FILE: path.join(__dirname, 'data', 'admin_data.json'),

  TIMEZONE: 'Asia/Seoul',
};

if (!CONFIG.TOKEN) {
  console.log('❌ TOKEN이 설정되지 않았습니다! (.env 또는 환경변수 TOKEN 확인)');
  process.exit(1);
}

/* =========================
 * 1) CLIENT
 * ========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // 가입일/역할 확인
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* =========================
 * 2) DATA STORE
 * ========================= */
let data = {
  소령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' },
  중령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' },
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function loadData() {
  ensureDir(CONFIG.DATA_DIR);
  if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
    } catch (e) {
      console.log('⚠️ admin_data.json 파싱 실패. 새로 생성합니다.', e?.message || e);
      saveData();
    }
  } else {
    saveData();
  }

  if (!data.소령) data.소령 = { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' };
  if (!data.중령) data.중령 = { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' };

  for (const k of ['소령', '중령']) {
    if (!data[k].history) data[k].history = { daily: {}, weekly: {} };
    if (!data[k].history.daily) data[k].history.daily = {};
    if (!data[k].history.weekly) data[k].history.weekly = {};
    if (!data[k].users) data[k].users = {};
    if (!data[k].weekStart) data[k].weekStart = '';
    if (!data[k].lastWeekStart) data[k].lastWeekStart = '';
  }
}
function saveData() {
  ensureDir(CONFIG.DATA_DIR);
  fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
}

/* =========================
 * 3) TIME UTILS (reportDate: 02:00 기준)
 * ========================= */
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
  const day = d.getUTCDay();
  return addDays(dateStr, -day);
}

/* =========================
 * 4) ROLE / PERMISSION UTILS
 * ========================= */
function memberHasRole(member, roleId) {
  return member?.roles?.cache?.has(roleId) === true;
}
function memberHasAnyRole(member, roleIds) {
  return roleIds.some(id => memberHasRole(member, id));
}
function isSupervisor(member) {
  return member?.roles?.cache?.some(r => CONFIG.SUPERVISOR_ROLE_IDS.includes(r.id)) === true;
}
function isMajor(member) {
  return memberHasRole(member, CONFIG.MAJOR_ROLE_ID);
}
function isLtCol(member) {
  return memberHasRole(member, CONFIG.LTCOL_ROLE_ID);
}

/* =========================
 * 5) SCORE CALC
 * ========================= */
function calculate소령(input) {
  return (input.권한지급 || 0) + (input.랭크변경 || 0) + (input.팀변경 || 0);
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
function getExtra중령(input) {
  return (input.인게임시험 || 0) * 1 + (input.코호스트 || 0) * 1 + (input.피드백 || 0) * 2;
}
function getAdminPointsByPercentile(pct) {
  if (pct <= 10) return 70;
  if (pct <= 34) return 50;
  if (pct <= 66) return 40;
  if (pct <= 90) return 30;
  return 20;
}
function recomputeTotals(group) {
  for (const u of Object.values(group.users || {})) {
    let a = 0, e = 0;
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

/* =========================
 * 6) ROSTER HELPERS
 * ========================= */
// 특정 역할 보유자 닉네임 맵 (userId -> displayName)
async function getRoleNickMap(guild, roleId) {
  const map = new Map();
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return map;
  role.members.forEach(m => map.set(m.id, m.displayName || m.user?.username || '알수없음'));
  return map;
}

// report submitter + role holders union
function buildRoster(rankName, roleNickMap) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  const rosterMap = new Map();

  // 보고 제출자
  for (const [uid, u] of Object.entries(group.users || {})) {
    rosterMap.set(uid, { userId: uid, nick: u?.nick || '알수없음', dailyRef: u?.daily || null });
  }

  // 역할 보유자도 포함(보고 없으면 0점)
  for (const [uid, nick] of roleNickMap.entries()) {
    if (!rosterMap.has(uid)) rosterMap.set(uid, { userId: uid, nick: nick || '알수없음', dailyRef: null });
    else {
      const cur = rosterMap.get(uid);
      if (nick && (!cur.nick || cur.nick === '알수없음')) cur.nick = nick;
    }
  }

  return Array.from(rosterMap.values());
}

/* =========================
 * 7) SCORE BUILDERS
 * ========================= */
function buildDayScoresFromRoster(rankName, dateStr, roster) {
  const is소령 = rankName === '소령';
  const minRequired = is소령 ? 3 : 4;

  const rows = (roster || []).map(r => {
    const adminUnits = r?.dailyRef?.[dateStr]?.admin ?? 0;
    const extraRaw = r?.dailyRef?.[dateStr]?.extra ?? 0;
    const meetsMin = adminUnits >= minRequired;

    return {
      userId: r.userId,
      nick: r.nick || '알수없음',
      adminUnits,
      extraRaw,
      meetsMin,
      adminPoints: 0,
      extraPoints: 0,
      total: 0,
      percentile: null,
    };
  });

  const eligible = rows.filter(x => x.meetsMin).sort((a, b) => b.adminUnits - a.adminUnits);
  const n = eligible.length;

  for (let i = 0; i < n; i++) {
    const cur = eligible[i];
    let start = i;
    while (start > 0 && eligible[start - 1].adminUnits === cur.adminUnits) start--;

    const pct = Math.floor((start / n) * 100) + 1; // 1등은 1% 근처
    cur.percentile = pct;
    cur.adminPoints = getAdminPointsByPercentile(pct);
    cur.extraPoints = Math.min(30, cur.extraRaw);
    cur.total = Math.min(100, cur.adminPoints + cur.extraPoints);
  }

  // 미달자는 0점
  for (const r of rows) {
    if (!r.meetsMin) {
      r.adminPoints = 0;
      r.extraPoints = 0;
      r.total = 0;
      r.percentile = null;
    }
  }

  return { rows, display: [...rows].sort((a, b) => b.total - a.total), dateStr };
}

function makeWeeklySnapshotOptimized(rankName, weekStart, roster) {
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const totals = new Map();
  (roster || []).forEach(r => totals.set(r.userId, { userId: r.userId, nick: r.nick || '알수없음', weeklyTotal: 0 }));

  const dayCache = new Map();
  for (const d of weekDates) {
    let dayRows = dayCache.get(d);
    if (!dayRows) {
      dayRows = buildDayScoresFromRoster(rankName, d, roster).rows;
      dayCache.set(d, dayRows);
    }
    for (const r of dayRows) {
      if (!totals.has(r.userId)) totals.set(r.userId, { userId: r.userId, nick: r.nick, weeklyTotal: 0 });
      totals.get(r.userId).weeklyTotal += r.total;
    }
  }

  const list = Array.from(totals.values()).sort((a, b) => b.weeklyTotal - a.weeklyTotal);
  return { weekStart, weekEnd: addDays(weekStart, 6), list };
}

/* =========================
 * 8) PRUNE / AUTO SNAPSHOT
 * ========================= */
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
}
function pruneOldWeekly(keepWeeks) {
  const cutoff = addDays(getReportDate(), -(keepWeeks * 7));
  for (const k of Object.keys(data.소령.history.weekly || {})) if (k < cutoff) delete data.소령.history.weekly[k];
  for (const k of Object.keys(data.중령.history.weekly || {})) if (k < cutoff) delete data.중령.history.weekly[k];
}
function runDailyAutoReset() {
  const y = getYesterdayDate();

  const rosterMaj = Object.entries(data.소령.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));
  const rosterLt = Object.entries(data.중령.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));

  data.소령.history.daily[y] = buildDayScoresFromRoster('소령', y, rosterMaj).display.map(r => ({
    userId: r.userId, nick: r.nick, total: r.total, adminPoints: r.adminPoints, extraPoints: r.extraPoints, percentile: r.percentile, meetsMin: r.meetsMin
  }));
  data.중령.history.daily[y] = buildDayScoresFromRoster('중령', y, rosterLt).display.map(r => ({
    userId: r.userId, nick: r.nick, total: r.total, adminPoints: r.adminPoints, extraPoints: r.extraPoints, percentile: r.percentile, meetsMin: r.meetsMin
  }));

  pruneOldDaily(21);
  saveData();
  console.log(`🧹 어제 스냅샷 저장 완료 (${y})`);
}
function runWeeklyAutoReset() {
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);
  const lastWeekStart = addDays(thisWeekStart, -7);

  const rosterMaj = Object.entries(data.소령.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));
  const rosterLt = Object.entries(data.중령.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));

  data.소령.history.weekly[lastWeekStart] = makeWeeklySnapshotOptimized('소령', lastWeekStart, rosterMaj);
  data.중령.history.weekly[lastWeekStart] = makeWeeklySnapshotOptimized('중령', lastWeekStart, rosterLt);

  data.소령.lastWeekStart = lastWeekStart;
  data.중령.lastWeekStart = lastWeekStart;

  data.소령.weekStart = thisWeekStart;
  data.중령.weekStart = thisWeekStart;

  pruneOldWeekly(12);
  saveData();
  console.log(`🔄 주간 스냅샷 저장 완료 (this=${thisWeekStart}, last=${lastWeekStart})`);
}

/* =========================
 * 9) WEEK CLEAR (/초기화주간)
 * ========================= */
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

/* =========================
 * 10) PAGINATION CACHE
 * ========================= */
const PAGE_CACHE = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of PAGE_CACHE.entries()) {
    if (!v?.createdAt || now - v.createdAt > CONFIG.CACHE_TTL_MS) PAGE_CACHE.delete(k);
  }
}, 60 * 1000);

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function makeNavRow(prefix, page, totalPages) {
  const disabledAll = totalPages <= 1;

  const prev = new ButtonBuilder()
    .setCustomId(`${prefix}:prev`)
    .setLabel('이전')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabledAll || page <= 0);

  const info = new ButtonBuilder()
    .setCustomId(`${prefix}:info`)
    .setLabel(`${totalPages === 0 ? 0 : page + 1}/${Math.max(totalPages, 1)}`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(true);

  const next = new ButtonBuilder()
    .setCustomId(`${prefix}:next`)
    .setLabel('다음')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabledAll || page >= totalPages - 1);

  return new ActionRowBuilder().addComponents(prev, info, next);
}

/* =========================
 * 11) EMBEDS
 * ========================= */
function embedToday(rankName, dateStr, rowsPage, page, totalPages, totalCount) {
  const lines = (rowsPage || []).length
    ? rowsPage.map((r, i) => {
      const idx = page * CONFIG.PAGE_SIZE + i + 1;
      const minText = r.meetsMin ? '' : ' (최소업무 미달)';
      const pctText = r.percentile ? ` / 상위 ${r.percentile}%` : '';
      return `**${idx}위** ${r.nick} — **${r.total}점** 〔행정: ${r.adminPoints}${pctText} / 추가: ${r.extraPoints}${minText}〕`;
    }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} 오늘 점수 (최대 100점)`)
    .setDescription(`**일자**: ${dateStr}\n**표시 인원**: ${totalCount}명\n\n${lines}`)
    .setFooter({ text: `페이지 ${totalPages === 0 ? 0 : page + 1}/${Math.max(totalPages, 1)} | 최소업무 미달자는 0점 + 퍼센트 제외` });
}

function embedWeekly(rankName, weekStart, weekEnd, listPage, page, totalPages, totalCount) {
  const lines = (listPage || []).length
    ? listPage.map((u, i) => {
      const idx = page * CONFIG.PAGE_SIZE + i + 1;
      return `**${idx}위** ${u.nick} — **${u.weeklyTotal}점**`;
    }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} 주간 점수`)
    .setDescription(`**주간 범위(새벽 2시 기준)**: ${weekStart} ~ ${weekEnd} (7일)\n**표시 인원**: ${totalCount}명\n\n${lines}`)
    .setFooter({ text: `페이지 ${totalPages === 0 ? 0 : page + 1}/${Math.max(totalPages, 1)}` });
}

function embedDemotion(title, weekStart, weekEnd, listPage, page, totalPages, totalCount) {
  const lines = (listPage || []).length
    ? listPage.map((x, i) => {
      const idx = page * CONFIG.PAGE_SIZE + i + 1;
      return `**${idx}.** ${x.nick} <@${x.userId}> — **${x.weeklyTotal}점**`;
    }).join('\n')
    : '✅ 조건에 해당하는 인원이 없습니다.';

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      `**주간 범위(새벽 2시 기준)**: ${weekStart} ~ ${weekEnd}\n` +
      `**대상 인원**: ${totalCount}명\n` +
      `**제외 조건**: 가입 7일 미만 + 일부 대상 제외\n\n` +  // ✅ 표시 개선
      lines
    )
    .setFooter({ text: `페이지 ${totalPages === 0 ? 0 : page + 1}/${Math.max(totalPages, 1)}` });
}

/* =========================
 * 12) COMMAND DEFINITIONS
 * ========================= */
function buildCommands() {
  const 소령 = new SlashCommandBuilder()
    .setName('소령행정보고')
    .setDescription('소령 행정 보고서 (소령 전용)')
    .addIntegerOption(o => o.setName('권한지급').setDescription('권한 지급 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('랭크변경').setDescription('랭크 변경 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('팀변경').setDescription('팀 변경 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('보직모집').setDescription('보직 가입 요청·모집 시험 : n건 (추가 2점/건)').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건 (추가 1점/건)').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    소령.addAttachmentOption(o => o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false));
  }

  const 중령 = new SlashCommandBuilder()
    .setName('중령행정보고')
    .setDescription('중령 행정 보고서 (중령 전용)')
    .addIntegerOption(o => o.setName('역할지급').setDescription('역할 지급 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인증').setDescription('인증 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('서버역할').setDescription('서버 역할 요청 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('감찰').setDescription('행정 감찰 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('코호스트').setDescription('인게임 코호스트 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('피드백').setDescription('피드백 제공 : n건').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    중령.addAttachmentOption(o => o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false));
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

  return [
    소령,
    중령,

    new SlashCommandBuilder().setName('소령오늘점수').setDescription('소령 오늘 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령오늘점수').setDescription('중령 오늘 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('소령주간점수').setDescription('소령 주간 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령주간점수').setDescription('중령 주간 점수 (감독관 전용)'),

    소령오늘초기화,
    중령오늘초기화,
    new SlashCommandBuilder().setName('초기화주간').setDescription('주간 전체 초기화 (감독관)'),
    new SlashCommandBuilder().setName('행정통계').setDescription('전체 통계 (감독관)'),

    new SlashCommandBuilder().setName('강등대상').setDescription('이번 주 주간 점수 150점 미만 인원 표시 (감독관 전용)'),
  ];
}

/* =========================
 * 13) COMMAND REGISTRATION (REST)
 * ========================= */
async function registerCommandsREST() {
  if (!client.application?.id) await client.application?.fetch?.().catch(() => null);
  const appId = client.application?.id;
  if (!appId) {
    console.log('❌ Application ID를 얻지 못했습니다. (client.application.id)');
    return;
  }

  const commands = buildCommands().map(c => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(CONFIG.TOKEN);

  try {
    await rest.put(Routes.applicationGuildCommands(appId, CONFIG.GUILD_ID), { body: commands });
    console.log(`✅ 슬래시 명령어 등록 완료 (appId=${appId})`);
  } catch (e) {
    console.log('❌ 슬래시 명령어 등록 실패:', e?.message || e);
  }
}

/* =========================
 * 14) PAGINATED REPLIES
 * ========================= */
async function replyPaginatedToday(interaction, rankName) {
  const guild = interaction.guild;
  const dateStr = getReportDate();

  // ✅ 랭크별 include 역할
  const roleId = CONFIG.INCLUDE_ROLE_BY_RANK[rankName];
  const roleNickMap = await getRoleNickMap(guild, roleId);

  const roster = buildRoster(rankName, roleNickMap);
  const { display } = buildDayScoresFromRoster(rankName, dateStr, roster);

  const pages = chunkArray(display, CONFIG.PAGE_SIZE);
  const totalPages = pages.length;
  const page = 0;

  const prefix = `rank:today:${rankName}`;
  const msg = await interaction.reply({
    embeds: [embedToday(rankName, dateStr, pages[0] || [], page, totalPages, display.length)],
    components: [makeNavRow(prefix, page, totalPages)],
    fetchReply: true,
  });

  PAGE_CACHE.set(msg.id, { createdAt: Date.now(), type: 'rank_today', rankName, dateStr, display, page });
}

async function replyPaginatedWeekly(interaction, rankName) {
  const guild = interaction.guild;
  const group = rankName === '소령' ? data.소령 : data.중령;
  const weekStart = group.weekStart || getSundayWeekStart(getReportDate());

  // ✅ 랭크별 include 역할
  const roleId = CONFIG.INCLUDE_ROLE_BY_RANK[rankName];
  const roleNickMap = await getRoleNickMap(guild, roleId);

  const roster = buildRoster(rankName, roleNickMap);
  const weeklySnap = makeWeeklySnapshotOptimized(rankName, weekStart, roster);

  const list = weeklySnap.list || [];
  const pages = chunkArray(list, CONFIG.PAGE_SIZE);
  const totalPages = pages.length;
  const page = 0;

  const prefix = `rank:weekly:${rankName}`;
  const msg = await interaction.reply({
    embeds: [embedWeekly(rankName, weeklySnap.weekStart, weeklySnap.weekEnd, pages[0] || [], page, totalPages, list.length)],
    components: [makeNavRow(prefix, page, totalPages)],
    fetchReply: true,
  });

  PAGE_CACHE.set(msg.id, {
    createdAt: Date.now(),
    type: 'rank_weekly',
    rankName,
    weekStart: weeklySnap.weekStart,
    weekEnd: weeklySnap.weekEnd,
    list,
    page,
  });
}

/**
 * ✅ 강등대상 로직 (요구사항 기준으로 재설계)
 * 포함 대상 = (가입 7일 이상) AND (exclude roles 미보유) AND (DEMOTION_INCLUDE_ROLE_ID 보유)
 * → 그 중 주간점수 < 150 이면 반드시 포함
 *
 * 표시:
 * - 소령: 위 포함 대상 중 MAJOR_ROLE_ID 보유자
 * - 중령: 위 포함 대상 중 LTCOL_ROLE_ID 보유자
 * - 기타: 위 포함 대상 중 소령/중령 역할이 둘 다 없는 경우(누락 방지)
 */
async function replyPaginatedDemotions(interaction) {
  const guild = interaction.guild;
  await guild.members.fetch().catch(() => null);

  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  // 이번 주 범위는 각 그룹 weekStart 기준
  const majWeekStart = data.소령.weekStart || getSundayWeekStart(getReportDate());
  const ltWeekStart = data.중령.weekStart || getSundayWeekStart(getReportDate());

  // 강등대상 후보 역할(1018195906807480402) 보유자
  const candidateRole = await guild.roles.fetch(CONFIG.DEMOTION_INCLUDE_ROLE_ID).catch(() => null);
  const candidateMembers = candidateRole ? Array.from(candidateRole.members.values()) : [];

  // 후보들 중 "제외조건" 제거
  const filteredCandidates = candidateMembers.filter(m => {
    const joinedAt = m.joinedAt?.getTime?.();
    if (joinedAt && now - joinedAt < sevenDaysMs) return false; // 가입 7일 미만 제외
    if (memberHasAnyRole(m, CONFIG.DEMOTION_EXCLUDE_ROLE_IDS)) return false; // 일부 대상 제외
    return true;
  });

  // 후보 풀을 랭크별로 분리 (소령/중령/기타)
  const candMaj = [];
  const candLt = [];
  const candEtc = [];

  for (const m of filteredCandidates) {
    const nick = m.displayName || m.user?.username || '알수없음';
    const item = { userId: m.id, nick };

    const hasMaj = memberHasRole(m, CONFIG.MAJOR_ROLE_ID);
    const hasLt = memberHasRole(m, CONFIG.LTCOL_ROLE_ID);

    if (hasMaj) candMaj.push(item);
    if (hasLt) candLt.push(item);

    if (!hasMaj && !hasLt) candEtc.push(item);
  }

  // ✅ 주간점수 계산을 “후보 풀 기준”으로 확실히 포함되도록 roster 구성
  const makeRosterForCandidates = (rankName, candidates) => {
    const group = rankName === '소령' ? data.소령 : data.중령;

    const rosterMap = new Map();
    // 보고 제출자
    for (const [uid, u] of Object.entries(group.users || {})) {
      rosterMap.set(uid, { userId: uid, nick: u?.nick || '알수없음', dailyRef: u?.daily || null });
    }
    // 후보자(보고 없으면 0점)
    for (const c of candidates) {
      if (!rosterMap.has(c.userId)) rosterMap.set(c.userId, { userId: c.userId, nick: c.nick, dailyRef: null });
      else {
        const cur = rosterMap.get(c.userId);
        if (c.nick && (!cur.nick || cur.nick === '알수없음')) cur.nick = c.nick;
      }
    }
    return Array.from(rosterMap.values());
  };

  const rosterMaj = makeRosterForCandidates('소령', candMaj);
  const rosterLt = makeRosterForCandidates('중령', candLt);

  const weeklyMaj = makeWeeklySnapshotOptimized('소령', majWeekStart, rosterMaj);
  const weeklyLt = makeWeeklySnapshotOptimized('중령', ltWeekStart, rosterLt);

  const majTotalMap = new Map((weeklyMaj.list || []).map(x => [x.userId, x.weeklyTotal]));
  const ltTotalMap = new Map((weeklyLt.list || []).map(x => [x.userId, x.weeklyTotal]));

  // 최종 강등대상 = 후보풀 중 주간 < 150
  const demoteMaj = candMaj
    .map(c => ({ userId: c.userId, nick: c.nick, weeklyTotal: majTotalMap.get(c.userId) ?? 0 }))
    .filter(x => x.weeklyTotal < CONFIG.DEMOTION_THRESHOLD)
    .sort((a, b) => a.weeklyTotal - b.weeklyTotal);

  const demoteLt = candLt
    .map(c => ({ userId: c.userId, nick: c.nick, weeklyTotal: ltTotalMap.get(c.userId) ?? 0 }))
    .filter(x => x.weeklyTotal < CONFIG.DEMOTION_THRESHOLD)
    .sort((a, b) => a.weeklyTotal - b.weeklyTotal);

  // 기타는 주간점수 계산이 “랭크 점수 모델”과 다를 수 있어 0으로 표시(누락 방지 용도)
  // 원하면 ‘기타도 소령 모델로 계산’ 같은 정책으로 변경 가능
  const demoteEtc = candEtc
    .map(c => ({ userId: c.userId, nick: c.nick, weeklyTotal: 0 }))
    .filter(x => x.weeklyTotal < CONFIG.DEMOTION_THRESHOLD);

  const pagesMaj = chunkArray(demoteMaj, CONFIG.PAGE_SIZE);
  const pagesLt = chunkArray(demoteLt, CONFIG.PAGE_SIZE);
  const pagesEtc = chunkArray(demoteEtc, CONFIG.PAGE_SIZE);

  const pMaj = 0, pLt = 0, pEtc = 0;

  const embeds = [
    embedDemotion(`강등 대상 [소령] (주간 ${CONFIG.DEMOTION_THRESHOLD}점 미만)`, weeklyMaj.weekStart, weeklyMaj.weekEnd, pagesMaj[pMaj] || [], pMaj, pagesMaj.length, demoteMaj.length),
    embedDemotion(`강등 대상 [중령] (주간 ${CONFIG.DEMOTION_THRESHOLD}점 미만)`, weeklyLt.weekStart, weeklyLt.weekEnd, pagesLt[pLt] || [], pLt, pagesLt.length, demoteLt.length),
  ];

  const rows = [
    makeNavRow('demote:maj', pMaj, pagesMaj.length),
    makeNavRow('demote:lt', pLt, pagesLt.length),
  ];

  // 기타 임베드(누락 방지)
  if (demoteEtc.length > 0) {
    embeds.push(embedDemotion(`강등 대상 [기타] (소령/중령 역할 없음, 누락 방지)`, weeklyMaj.weekStart, weeklyMaj.weekEnd, pagesEtc[pEtc] || [], pEtc, pagesEtc.length, demoteEtc.length));
    rows.push(makeNavRow('demote:etc', pEtc, pagesEtc.length));
  }

  const msg = await interaction.reply({
    embeds,
    components: rows,
    fetchReply: true,
  });

  PAGE_CACHE.set(msg.id, {
    createdAt: Date.now(),
    type: 'demotions',
    maj: { weekStart: weeklyMaj.weekStart, weekEnd: weeklyMaj.weekEnd, list: demoteMaj, page: pMaj },
    lt: { weekStart: weeklyLt.weekStart, weekEnd: weeklyLt.weekEnd, list: demoteLt, page: pLt },
    etc: { weekStart: weeklyMaj.weekStart, weekEnd: weeklyMaj.weekEnd, list: demoteEtc, page: pEtc },
  });
}

/* =========================
 * 15) BUTTON HANDLER
 * ========================= */
async function handleButton(interaction) {
  const state = PAGE_CACHE.get(interaction.message?.id);
  if (!state) {
    return interaction.reply({ content: '⚠️ 페이지 정보가 만료되었습니다. 명령어를 다시 실행해 주세요.', ephemeral: true });
  }

  const parts = interaction.customId.split(':');

  // rank:today|weekly:소령|중령:prev|next|info
  if (parts[0] === 'rank') {
    const mode = parts[1];
    const rankName = parts[2];
    const action = parts[3];

    if (action === 'info') return interaction.deferUpdate();
    if (state.rankName !== rankName) return interaction.deferUpdate();

    if (state.type === 'rank_today' && mode === 'today') {
      const pages = chunkArray(state.display, CONFIG.PAGE_SIZE);
      const totalPages = pages.length;
      let page = state.page || 0;

      if (action === 'prev') page = Math.max(0, page - 1);
      if (action === 'next') page = Math.min(totalPages - 1, page + 1);
      state.page = page;

      return interaction.update({
        embeds: [embedToday(rankName, state.dateStr, pages[page] || [], page, totalPages, state.display.length)],
        components: [makeNavRow(`rank:today:${rankName}`, page, totalPages)],
      });
    }

    if (state.type === 'rank_weekly' && mode === 'weekly') {
      const pages = chunkArray(state.list, CONFIG.PAGE_SIZE);
      const totalPages = pages.length;
      let page = state.page || 0;

      if (action === 'prev') page = Math.max(0, page - 1);
      if (action === 'next') page = Math.min(totalPages - 1, page + 1);
      state.page = page;

      return interaction.update({
        embeds: [embedWeekly(rankName, state.weekStart, state.weekEnd, pages[page] || [], page, totalPages, state.list.length)],
        components: [makeNavRow(`rank:weekly:${rankName}`, page, totalPages)],
      });
    }

    return interaction.deferUpdate();
  }

  // demote:maj|lt|etc:prev|next|info
  if (parts[0] === 'demote' && state.type === 'demotions') {
    const which = parts[1]; // maj|lt|etc
    const action = parts[2];
    if (action === 'info') return interaction.deferUpdate();

    const slot = state[which];
    if (!slot) return interaction.deferUpdate();

    const pages = chunkArray(slot.list, CONFIG.PAGE_SIZE);
    const totalPages = pages.length;

    let page = slot.page || 0;
    if (action === 'prev') page = Math.max(0, page - 1);
    if (action === 'next') page = Math.min(Math.max(totalPages - 1, 0), page + 1);
    slot.page = page;

    const majPages = chunkArray(state.maj.list, CONFIG.PAGE_SIZE);
    const ltPages = chunkArray(state.lt.list, CONFIG.PAGE_SIZE);
    const etcPages = chunkArray(state.etc?.list || [], CONFIG.PAGE_SIZE);

    const embeds = [
      embedDemotion(`강등 대상 [소령] (주간 ${CONFIG.DEMOTION_THRESHOLD}점 미만)`, state.maj.weekStart, state.maj.weekEnd, majPages[state.maj.page] || [], state.maj.page, majPages.length, state.maj.list.length),
      embedDemotion(`강등 대상 [중령] (주간 ${CONFIG.DEMOTION_THRESHOLD}점 미만)`, state.lt.weekStart, state.lt.weekEnd, ltPages[state.lt.page] || [], state.lt.page, ltPages.length, state.lt.list.length),
    ];
    const rows = [
      makeNavRow('demote:maj', state.maj.page, majPages.length),
      makeNavRow('demote:lt', state.lt.page, ltPages.length),
    ];

    if ((state.etc?.list || []).length > 0) {
      embeds.push(embedDemotion(`강등 대상 [기타] (소령/중령 역할 없음, 누락 방지)`, state.etc.weekStart, state.etc.weekEnd, etcPages[state.etc.page] || [], state.etc.page, etcPages.length, state.etc.list.length));
      rows.push(makeNavRow('demote:etc', state.etc.page, etcPages.length));
    }

    return interaction.update({ embeds, components: rows });
  }

  return interaction.deferUpdate();
}

/* =========================
 * 16) REPORT HANDLER (닉네임 입력 제거 + 자동 멘션)
 * ========================= */
function buildEvidence(interaction) {
  const photos = [];
  for (let i = 1; i <= 10; i++) {
    const att = interaction.options.getAttachment(`증거사진${i}`);
    if (att) photos.push(att);
  }
  if (photos.length === 0) return { embeds: [], files: [] };

  const files = photos.slice(0, 10).map((att, idx) => ({
    attachment: att.url,
    name: `evidence_${idx + 1}_${att.name || 'image.png'}`,
  }));

  const links = photos.slice(0, 10).map((att, idx) => `[[사진${idx + 1}]](${att.url})`).join('  •  ');
  const embeds = [new EmbedBuilder().setTitle('📸 증거 사진').setDescription(links)];

  return { embeds, files };
}

async function handleReport(interaction, rankName) {
  const member = interaction.member;
  const userId = interaction.user.id;
  const date = getReportDate();

  const storedNick = member?.displayName || interaction.user.username;

  let adminCount = 0;
  let extra = 0;

  let content =
    `✅ **${rankName} 보고 완료!**\n` +
    `**닉네임**: <@${userId}>\n` +
    `**일자**: ${date}\n\n`;

  if (rankName === '소령') {
    const input = {
      권한지급: interaction.options.getInteger('권한지급'),
      랭크변경: interaction.options.getInteger('랭크변경'),
      팀변경: interaction.options.getInteger('팀변경'),
      보직모집: interaction.options.getInteger('보직모집'),
      인게임시험: interaction.options.getInteger('인게임시험'),
    };
    adminCount = calculate소령(input);
    extra = getExtra소령(input);

    content += `**권한지급**(행정): ${input.권한지급}건\n`;
    content += `**랭크변경**(행정): ${input.랭크변경}건\n`;
    content += `**팀변경**(행정): ${input.팀변경}건\n`;
    content += `**보직 가입 요청·모집 시험**(추가 2점/건): ${input.보직모집}건\n`;
    content += `**인게임 시험**(추가 1점/건): ${input.인게임시험}건\n`;
  } else {
    const input = {
      역할지급: interaction.options.getInteger('역할지급'),
      인증: interaction.options.getInteger('인증'),
      서버역할: interaction.options.getInteger('서버역할'),
      감찰: interaction.options.getInteger('감찰'),
      인게임시험: interaction.options.getInteger('인게임시험'),
      코호스트: interaction.options.getInteger('코호스트'),
      피드백: interaction.options.getInteger('피드백'),
    };
    adminCount = calculate중령(input);
    extra = getExtra중령(input);

    content += `**역할지급**(행정): ${input.역할지급}건\n`;
    content += `**인증**(행정): ${input.인증}건\n`;
    content += `**서버 역할 요청**(행정): ${input.서버역할}건\n`;
    content += `**행정 감찰**(행정): ${input.감찰}건\n`;
    content += `**인게임 시험**(추가): ${input.인게임시험}건\n`;
    content += `**인게임 코호스트**(추가): ${input.코호스트}건\n`;
    content += `**피드백 제공**(추가): ${input.피드백}건\n`;
  }

  const { embeds, files } = buildEvidence(interaction);
  if (files.length > 0) content += `\n📸 증거 사진 ${files.length}장 첨부됨`;

  const group = rankName === '소령' ? data.소령 : data.중령;
  if (!group.users[userId]) group.users[userId] = { nick: storedNick, totalAdmin: 0, totalExtra: 0, daily: {} };
  const u = group.users[userId];

  u.nick = storedNick;
  if (!u.daily[date]) u.daily[date] = { admin: 0, extra: 0 };

  u.daily[date].admin += adminCount;
  u.daily[date].extra += extra;

  u.totalAdmin = (u.totalAdmin || 0) + adminCount;
  u.totalExtra = (u.totalExtra || 0) + extra;

  saveData();

  return interaction.reply({ content, embeds, files, ephemeral: false });
}

/* =========================
 * 17) COMMANDS + READY
 * ========================= */
client.once('ready', async () => {
  console.log(`${client.user.tag} 준비 완료!`);

  loadData();

  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);

  if (!data.소령.weekStart) data.소령.weekStart = thisWeekStart;
  if (!data.중령.weekStart) data.중령.weekStart = thisWeekStart;
  saveData();

  await registerCommandsREST();

  cron.schedule('0 2 * * *', runDailyAutoReset, { timezone: CONFIG.TIMEZONE });
  cron.schedule('0 2 * * 0', runWeeklyAutoReset, { timezone: CONFIG.TIMEZONE });

  console.log('⏰ 스케줄 등록 완료 (매일 02:00 / 매주 일 02:00)');
});

/* =========================
 * 18) INTERACTIONS
 * ========================= */
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) return handleButton(interaction);
    if (!interaction.isChatInputCommand()) return;

    const cmd = interaction.commandName;
    const member = interaction.member;

    // 보고서 역할 제한
    if (cmd === '소령행정보고' && !isMajor(member)) {
      return interaction.reply({ content: '❌ 이 명령어는 **소령 역할**만 사용할 수 있습니다.', ephemeral: true });
    }
    if (cmd === '중령행정보고' && !isLtCol(member)) {
      return interaction.reply({ content: '❌ 이 명령어는 **중령 역할**만 사용할 수 있습니다.', ephemeral: true });
    }

    // 감독관 전용
    const supervisorOnly = new Set([
      '소령오늘점수', '중령오늘점수', '소령주간점수', '중령주간점수',
      '강등대상',
    ]);
    if (supervisorOnly.has(cmd) && !isSupervisor(member)) {
      return interaction.reply({ content: '❌ 감독관만 사용할 수 있습니다.', ephemeral: true });
    }

    // 보고
    if (cmd === '소령행정보고') return handleReport(interaction, '소령');
    if (cmd === '중령행정보고') return handleReport(interaction, '중령');

    // 오늘/주간
    if (cmd === '소령오늘점수') return replyPaginatedToday(interaction, '소령');
    if (cmd === '중령오늘점수') return replyPaginatedToday(interaction, '중령');
    if (cmd === '소령주간점수') return replyPaginatedWeekly(interaction, '소령');
    if (cmd === '중령주간점수') return replyPaginatedWeekly(interaction, '중령');

    // 강등대상
    if (cmd === '강등대상') return replyPaginatedDemotions(interaction);

    return interaction.reply({ content: 'ℹ️ 알 수 없는 명령어입니다.', ephemeral: true });
  } catch (err) {
    console.log('❌ interaction 오류:', err?.stack || err);
    if (!interaction.replied) {
      return interaction.reply({ content: '❌ 처리 중 오류가 발생했습니다. 콘솔 로그를 확인해 주세요.', ephemeral: true })
        .catch(() => null);
    }
  }
});

client.login(CONFIG.TOKEN);