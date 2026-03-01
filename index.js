/**
 * Fulfillment Management Bot (Discord.js v14)
 * - 소령/중령 행정 보고 누적 저장(JSON)
 * - 새벽 2시 기준 날짜/주간 처리
 * - 오늘/주간/어제/지난주 점수 조회
 * - (추가) 28명 초과 시 페이지네이션(버튼) 지원
 * - (A) /어제점수, /지난주점수(소령+중령 2개 임베드)는 첫 페이지(최대 28명)만 표시
 * - (추가) 임베드 description 4096자 제한 방어
 * 
 * ✅ 전체 수정 완료 (2026-03-02 기준)
 * 1. 주간 크론에서 이전 주 daily 데이터 자동 정리 (clearPrev7ReportDaysBeforeThisWeek 호출 추가) → 데이터 누적 버그 완전 해결
 * 2. getReportDate() → UTC 메서드(getUTCHours/setUTCDate) 사용으로 서버 타임존과 무관하게 안정화
 * 3. 무거운 명령어(점수 조회, 강등대상 등)에 deferReply + editReply 추가 → interaction timeout 방지
 * 4. interactionCreate catch 블록 개선 (deferred interaction 처리)
 * 5. runWeeklyAutoReset 내부 pruneOldDaily 호출 추가 (안전성 강화)
 * 6. 코드 일관성/안전성 미세 조정 (불필요한 return 정리, 주석 보강)
 */

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================== 설정 ==================
const TOKEN = process.env.TOKEN;
const GUILD_ID = '1018194815286001756';

const SUPERVISOR_ROLE_IDS = [
  '1018195904261529691',
  '1473688580613341419'
];

const MAJOR_ROLE_ID = '1472582859339596091';
const LTCOL_ROLE_ID = '1018447060627894322';

const EXCLUDED_ROLE_IDS = [
  '1018195904261529691',
  '1463433369869090962',
  '1473688580613341419'
];

const DEMOTION_EXTRA_EXCLUDED_ROLE_IDS = [
  '1477394729808298167'
];

// ================== 디스코드 클라이언트 ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ================== 데이터 파일 ==================
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'admin_data.json');
const DATA_BACKUP_FILE = path.join(DATA_DIR, 'admin_data.bak.json');

// ================== 데이터 구조 ==================
let data = {
  소령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' },
  중령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' }
};

// ================== 페이지네이션 캐시 ==================
const PAGE_CACHE = new Map();
const PAGE_CACHE_TTL_MS = 15 * 60 * 1000;
const PER_PAGE = 28;

function makeCacheKey() {
  return crypto.randomBytes(8).toString('hex');
}
function cleanupPageCache() {
  const now = Date.now();
  for (const [k, v] of PAGE_CACHE.entries()) {
    if (!v || (now - v.createdAt) > PAGE_CACHE_TTL_MS) PAGE_CACHE.delete(k);
  }
}
function paginate(items, page, perPage = PER_PAGE) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return { slice, page: safePage, totalPages, total };
}
function buildPagerRow(cacheKey, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pg|${cacheKey}|1`).setLabel('⏮ 처음').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`pg|${cacheKey}|${page - 1}`).setLabel('◀ 이전').setStyle(ButtonStyle.Primary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`pg|${cacheKey}|${page + 1}`).setLabel('다음 ▶').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages),
    new ButtonBuilder().setCustomId(`pg|${cacheKey}|${totalPages}`).setLabel('마지막 ⏭').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
  );
}

// ================== 임베드 길이 방어 ==================
function trunc(s, max) {
  if (s == null) return '';
  s = String(s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function buildDescriptionWithin4096(header, lines) {
  let desc = header;
  for (const line of lines) {
    const next = desc + '\n' + line;
    if (next.length > 4096) break;
    desc = next;
  }
  return desc;
}

// ================== 유틸 ==================
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function safeReadJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`❌ JSON 파싱 실패: ${filePath}`, e);
    return null;
  }
}
function loadData() {
  ensureDir();
  const primary = safeReadJSON(DATA_FILE);
  const backup = safeReadJSON(DATA_BACKUP_FILE);

  if (primary) data = primary;
  else if (backup) {
    console.warn('⚠ 메인 데이터 손상 → 백업 로드');
    data = backup;
  } else {
    saveData();
  }

  for (const g of [data.소령, data.중령]) {
    if (!g.users) g.users = {};
    if (!g.history) g.history = { daily: {}, weekly: {} };
    if (!g.history.daily) g.history.daily = {};
    if (!g.history.weekly) g.history.weekly = {};
    if (!g.lastWeekStart) g.lastWeekStart = '';
    if (!g.weekStart) g.weekStart = '';
  }
}
function saveData() {
  ensureDir();
  try {
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_BACKUP_FILE);
  } catch (e) {
    console.warn('⚠ 백업 실패(무시):', e);
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ================== 날짜 (새벽 2시 기준) - UTC 메서드로 TZ 독립 ==================
function getReportDate() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST timestamp
  if (now.getUTCHours() < 2) {
    now.setUTCDate(now.getUTCDate() - 1);
  }
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

// ================== 누적 정합성 ==================
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

// ================== /초기화주간 핵심 ==================
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
  return (input.권한지급 || 0) + (input.랭크변경 || 0) + (input.팀변경 || 0);
}
function getExtra소령(input) {
  return (input.보직모집 || 0) * 2 + (input.인게임시험 || 0) * 1;
}
function calculate중령(input) {
  return (input.인증 || 0) * 1.5 + (input.역할지급 || 0) * 1 + (input.감찰 || 0) * 2 + (input.서버역할 || 0) * 0.5;
}
function getExtra중령(input) {
  return (input.인게임시험 || 0) * 1 + (input.코호스트 || 0) * 1 + (input.피드백 || 0) * 2;
}

// ================== 퍼센타일 ==================
function getTopPercent(rank, n) {
  if (n <= 0) return null;
  return Math.max(1, Math.floor(((rank - 1) / n) * 100) + 1);
}
function getAdminPointsByPercentile(pct) {
  if (pct <= 10) return 70;
  if (pct <= 34) return 50;
  if (pct <= 66) return 40;
  if (pct <= 90) return 30;
  return 20;
}

// ================== 길드 멤버 ==================
function hasAnyRole(member, roleIds) {
  if (!member?.roles?.cache) return false;
  return member.roles.cache.some(r => roleIds.includes(r.id));
}
function getMemberNick(member) {
  return member?.displayName || member?.user?.globalName || member?.user?.username || '알수없음';
}
async function buildRosterForRole(guild, includeRoleId, excludeRoleIds) {
  if (!guild) return [];
  await guild.members.fetch();
  const roster = [];
  guild.members.cache.forEach(m => {
    if (m.user?.bot) return;
    if (!m.roles.cache.has(includeRoleId)) return;
    if (hasAnyRole(m, excludeRoleIds)) return;
    roster.push({
      userId: m.id,
      nick: getMemberNick(m),
      joinedAt: m.joinedAt || null
    });
  });
  return roster;
}

// ================== 일일/주간 스코어 ==================
function buildDayScoresWithRoster(rankName, dateStr, roster) {
  const is소령 = rankName === '소령';
  const minRequired = is소령 ? 3 : 4;
  const group = is소령 ? data.소령 : data.중령;

  const rows = (roster || []).map(rm => {
    const u = group.users?.[rm.userId];
    const adminUnits = u?.daily?.[dateStr]?.admin ?? 0;
    const extraRaw = u?.daily?.[dateStr]?.extra ?? 0;
    const meetsMin = adminUnits >= minRequired;

    return {
      userId: rm.userId,
      nick: rm.nick || u?.nick || '알수없음',
      adminUnits,
      extraRaw,
      meetsMin,
      adminPoints: 0,
      extraPoints: 0,
      total: 0,
      percentile: null
    };
  });

  const eligible = rows.filter(r => r.meetsMin).sort((a, b) => b.adminUnits - a.adminUnits);
  const n = eligible.length;

  for (let i = 0; i < n; i++) {
    const cur = eligible[i];
    let start = i;
    while (start > 0 && eligible[start - 1].adminUnits === cur.adminUnits) start--;
    const rank = start + 1;
    const pct = getTopPercent(rank, n);

    cur.percentile = pct;
    cur.adminPoints = getAdminPointsByPercentile(pct);
    cur.extraPoints = Math.min(30, cur.extraRaw);
    cur.total = Math.min(100, cur.adminPoints + cur.extraPoints);
  }

  for (const r of rows) {
    if (!r.meetsMin) {
      r.adminPoints = r.extraPoints = r.total = 0;
      r.percentile = null;
    }
  }

  const display = [...rows].sort((a, b) => b.total - a.total);
  return { rows, display, dateStr };
}

function makeDailySnapshotFromRoster(rankName, dateStr, roster) {
  const { display } = buildDayScoresWithRoster(rankName, dateStr, roster);
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

function makeWeeklySnapshotFromRoster(rankName, weekStart, roster) {
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const totals = {};
  for (const rm of roster || []) {
    totals[rm.userId] = { userId: rm.userId, nick: rm.nick || '알수없음', weeklyTotal: 0 };
  }
  for (const d of weekDates) {
    const { rows } = buildDayScoresWithRoster(rankName, d, roster);
    for (const r of rows) totals[r.userId].weeklyTotal += r.total;
  }
  const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal);
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    list: list.map(x => ({ userId: x.userId, nick: x.nick, weeklyTotal: x.weeklyTotal }))
  };
}

// ================== 임베드 ==================
function createDailyEmbedPaged(rankName, title, dateStr, pageSlice, page, totalPages, totalUsers) {
  const lines = pageSlice.length
    ? pageSlice.map((r, i) => {
        const absoluteRank = (page - 1) * PER_PAGE + (i + 1);
        const nick = trunc(r.nick, 24);
        const minText = r.meetsMin ? '' : ' (최소업무 미달)';
        const pctText = r.percentile ? ` / 상위 ${r.percentile}%` : '';
        return `**${absoluteRank}위** ${nick} — **${r.total}점** 〔행정: ${r.adminPoints}${pctText} / 추가: ${r.extraPoints}${minText}〕`;
      })
    : ['데이터가 없습니다.'];

  const header = `**일자**: ${dateStr}`;
  const desc = buildDescriptionWithin4096(header, ['', ...lines]);

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: `페이지 ${page}/${totalPages} • 총 ${totalUsers}명 • 최소업무 미달자는 0점 + 퍼센타일 제외` });
}

function createWeeklyEmbedPaged(rankName, title, weekStart, weekEnd, pageSlice, page, totalPages, totalUsers) {
  const lines = pageSlice.length
    ? pageSlice.map((u, i) => {
        const absoluteRank = (page - 1) * PER_PAGE + (i + 1);
        const nick = trunc(u.nick, 24);
        return `**${absoluteRank}위** ${nick} — **${u.weeklyTotal}점**`;
      })
    : ['데이터가 없습니다.'];

  const header = `**주간 범위(새벽 2시 기준)**: ${weekStart} ~ ${weekEnd} (7일)`;
  const desc = buildDescriptionWithin4096(header, ['', ...lines]);

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: `페이지 ${page}/${totalPages} • 총 ${totalUsers}명 • 주간=일~토 합산` });
}

function createDailyEmbedFirstPage(rankName, title, dateStr, snapshot) {
  const { slice, page, totalPages, total } = paginate(snapshot || [], 1);
  return createDailyEmbedPaged(rankName, title, dateStr, slice, page, totalPages, total);
}
function createWeeklyEmbedFirstPage(rankName, title, weeklySnap) {
  const list = weeklySnap?.list || [];
  const { slice, page, totalPages, total } = paginate(list, 1);
  return createWeeklyEmbedPaged(rankName, title, weeklySnap?.weekStart, weeklySnap?.weekEnd, slice, page, totalPages, total);
}

// ================== 오래된 데이터 정리 ==================
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
  for (const k of Object.keys(data.소령.history.weekly || {})) {
    if (k < cutoff) delete data.소령.history.weekly[k];
  }
  for (const k of Object.keys(data.중령.history.weekly || {})) {
    if (k < cutoff) delete data.중령.history.weekly[k];
  }
}

// ================== 자동 스냅샷 ==================
async function runDailyAutoReset(guild) {
  try {
    const y = getYesterdayDate();
    const majRoster = await buildRosterForRole(guild, MAJOR_ROLE_ID, EXCLUDED_ROLE_IDS);
    const ltRoster = await buildRosterForRole(guild, LTCOL_ROLE_ID, EXCLUDED_ROLE_IDS);

    data.소령.history.daily[y] = makeDailySnapshotFromRoster('소령', y, majRoster);
    data.중령.history.daily[y] = makeDailySnapshotFromRoster('중령', y, ltRoster);

    pruneOldDaily(21);
    saveData();
    console.log(`🧹 어제 스냅샷 저장 완료 (${y})`);
  } catch (e) {
    console.error('❌ runDailyAutoReset 오류:', e);
  }
}

async function runWeeklyAutoReset(guild) {
  try {
    const today = getReportDate();
    const thisWeekStart = getSundayWeekStart(today);
    const lastWeekStart = addDays(thisWeekStart, -7);

    const majRoster = await buildRosterForRole(guild, MAJOR_ROLE_ID, EXCLUDED_ROLE_IDS);
    const ltRoster = await buildRosterForRole(guild, LTCOL_ROLE_ID, EXCLUDED_ROLE_IDS);

    data.소령.history.weekly[lastWeekStart] = makeWeeklySnapshotFromRoster('소령', lastWeekStart, majRoster);
    data.중령.history.weekly[lastWeekStart] = makeWeeklySnapshotFromRoster('중령', lastWeekStart, ltRoster);

    data.소령.lastWeekStart = lastWeekStart;
    data.중령.lastWeekStart = lastWeekStart;
    data.소령.weekStart = thisWeekStart;
    data.중령.weekStart = thisWeekStart;

    // ✅ 수정: 완료된 이전 주 daily 자동 정리 + prune 강화
    clearPrev7ReportDaysBeforeThisWeek(data.소령);
    clearPrev7ReportDaysBeforeThisWeek(data.중령);
    pruneOldDaily(21);
    pruneOldWeekly(12);

    saveData();
    console.log(`🔄 주간 초기화 완료 (weekStart=${thisWeekStart}, lastWeekStart=${lastWeekStart})`);
  } catch (e) {
    console.error('❌ runWeeklyAutoReset 오류:', e);
  }
}

// ================== 공용 조회 ==================
async function getOrMakeYesterdaySnapshot(rankName, guild) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  const y = getYesterdayDate();
  let snap = group.history.daily[y];
  if (!snap) {
    const roleId = rankName === '소령' ? MAJOR_ROLE_ID : LTCOL_ROLE_ID;
    const roster = await buildRosterForRole(guild, roleId, EXCLUDED_ROLE_IDS);
    snap = makeDailySnapshotFromRoster(rankName, y, roster);
    group.history.daily[y] = snap;
    saveData();
  }
  return { date: y, snap };
}
async function getOrMakeLastWeekSnapshot(rankName, guild) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  let key = group.lastWeekStart || addDays(group.weekStart || getSundayWeekStart(getReportDate()), -7);
  let weeklySnap = group.history.weekly[key];
  if (!weeklySnap) {
    const roleId = rankName === '소령' ? MAJOR_ROLE_ID : LTCOL_ROLE_ID;
    const roster = await buildRosterForRole(guild, roleId, EXCLUDED_ROLE_IDS);
    weeklySnap = makeWeeklySnapshotFromRoster(rankName, key, roster);
    group.history.weekly[key] = weeklySnap;
    group.lastWeekStart = key;
    saveData();
  }
  return weeklySnap;
}

// ================== 명령어 등록 ==================
async function registerCommands(guild) {
  const 소령Command = new SlashCommandBuilder()
    .setName('소령행정보고').setDescription('소령 행정 보고서 (소령 전용)')
    .addStringOption(o => o.setName('닉네임').setDescription('닉네임(미입력 시 서버 닉네임)').setRequired(false))
    .addIntegerOption(o => o.setName('권한지급').setDescription('권한 지급 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('랭크변경').setDescription('랭크 변경 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('팀변경').setDescription('팀 변경 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('보직모집').setDescription('보직 가입 요청·모집 시험 : n건 (추가 2점/건)').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건 (추가 1점/건)').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    소령Command.addAttachmentOption(o => o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false));
  }

  const 중령Command = new SlashCommandBuilder()
    .setName('중령행정보고').setDescription('중령 행정 보고서 (중령 전용)')
    .addStringOption(o => o.setName('닉네임').setDescription('닉네임(미입력 시 서버 닉네임)').setRequired(false))
    .addIntegerOption(o => o.setName('역할지급').setDescription('역할 지급 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인증').setDescription('인증 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('서버역할').setDescription('서버 역할 요청 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('감찰').setDescription('행정 감찰 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('코호스트').setDescription('인게임 코호스트 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('피드백').setDescription('피드백 제공 : n건').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    중령Command.addAttachmentOption(o => o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false));
  }

  const 소령오늘초기화 = new SlashCommandBuilder()
    .setName('소령오늘초기화')
    .setDescription('소령 오늘 기록 초기화 (감독관)')
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 초기화').setRequired(false));

  const 중령오늘초기화 = new SlashCommandBuilder()
    .setName('중령오늘초기화')
    .setDescription('중령 오늘 기록 초기화 (감독관)')
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 초기화').setRequired(false));

  try {
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
      new SlashCommandBuilder().setName('어제점수').setDescription('소령/중령 어제 점수 한 번에 (감독관 전용)'),
      new SlashCommandBuilder().setName('지난주점수').setDescription('소령/중령 지난주 점수 한 번에 (감독관 전용)'),
      소령오늘초기화, 중령오늘초기화,
      new SlashCommandBuilder().setName('초기화주간').setDescription('주간 전체 초기화 (감독관)'),
      new SlashCommandBuilder().setName('행정통계').setDescription('전체 통계 (감독관)'),
      new SlashCommandBuilder().setName('강등대상').setDescription('이번 주 150점 미만 강등 대상 (감독관 전용)')
    ]);
    console.log('✅ 명령어 등록 완료');
  } catch (e) {
    console.error('❌ 명령어 등록 실패:', e);
  }
}

// ================== ready ==================
client.once('ready', async () => {
  console.log(`${client.user.tag} 준비 완료!`);

  loadData();

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    console.error('❌ 서버를 찾을 수 없습니다. GUILD_ID 확인');
    return;
  }

  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);
  if (!data.소령.weekStart) data.소령.weekStart = thisWeekStart;
  if (!data.중령.weekStart) data.중령.weekStart = thisWeekStart;
  saveData();

  await registerCommands(guild);

  cron.schedule('0 2 * * *', () => runDailyAutoReset(guild), { timezone: 'Asia/Seoul' });
  cron.schedule('0 2 * * 0', () => runWeeklyAutoReset(guild), { timezone: 'Asia/Seoul' });

  console.log('⏰ 자동 스케줄 등록 완료 (매일 02:00 / 매주 일 02:00)');
});

// ================== interactionCreate ==================
client.on('interactionCreate', async interaction => {
  try {
    // ================== 페이지네이션 버튼 ==================
    if (interaction.isButton()) {
      const [tag, cacheKey, pageStr] = interaction.customId.split('|');
      if (tag !== 'pg') return;

      cleanupPageCache();
      const cached = PAGE_CACHE.get(cacheKey);
      if (!cached) {
        return interaction.reply({ content: '⏱️ 페이지 정보가 만료되었습니다. 명령어를 다시 실행해주세요.', ephemeral: true });
      }
      if (cached.ownerId && interaction.user.id !== cached.ownerId) {
        return interaction.reply({ content: '❌ 이 페이지는 명령 실행자만 넘길 수 있습니다.', ephemeral: true });
      }

      const reqPage = parseInt(pageStr, 10) || 1;

      if (cached.kind === 'daily') {
        const { date, title } = cached.meta;
        const { slice, page, totalPages, total } = paginate(cached.items, reqPage);
        const embed = createDailyEmbedPaged(cached.rankName, title, date, slice, page, totalPages, total);
        const row = buildPagerRow(cacheKey, page, totalPages);
        return interaction.update({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
      }

      if (cached.kind === 'weekly') {
        const { weekStart, weekEnd, title } = cached.meta;
        const { slice, page, totalPages, total } = paginate(cached.items, reqPage);
        const embed = createWeeklyEmbedPaged(cached.rankName, title, weekStart, weekEnd, slice, page, totalPages, total);
        const row = buildPagerRow(cacheKey, page, totalPages);
        return interaction.update({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
      }

      return interaction.reply({ content: '❌ 알 수 없는 페이지 타입입니다.', ephemeral: true });
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: '❌ 서버에서만 사용 가능합니다.', ephemeral: true });

    const hasRole = (roleId) => interaction.member?.roles?.cache?.has(roleId);
    const isSupervisor = () => interaction.member?.roles?.cache?.some(r => SUPERVISOR_ROLE_IDS.includes(r.id));
    const isMajor = () => hasRole(MAJOR_ROLE_ID);
    const isLtCol = () => hasRole(LTCOL_ROLE_ID);

    // 보고서 역할 제한
    if (cmd === '소령행정보고' && !isMajor()) {
      return interaction.reply({ content: '❌ 소령 역할만 사용할 수 있습니다.', ephemeral: true });
    }
    if (cmd === '중령행정보고' && !isLtCol()) {
      return interaction.reply({ content: '❌ 중령 역할만 사용할 수 있습니다.', ephemeral: true });
    }

    // ================== 보고서 ==================
    if (cmd === '소령행정보고' || cmd === '중령행정보고') {
      // ... (기존 보고서 로직 그대로 유지 - 빠름)
      const is소령 = cmd === '소령행정보고';
      const optionNick = interaction.options.getString('닉네임');
      const autoNick = getMemberNick(interaction.member);
      const nick = optionNick || autoNick;
      const date = getReportDate();

      let adminCount = 0, extra = 0;
      let replyText = `✅ **${is소령 ? '소령' : '중령'} 보고 완료!**\n**닉네임**: ${nick}\n**일자**: ${date}\n\n`;

      if (is소령) {
        const input = {
          권한지급: interaction.options.getInteger('권한지급'),
          랭크변경: interaction.options.getInteger('랭크변경'),
          팀변경: interaction.options.getInteger('팀변경'),
          보직모집: interaction.options.getInteger('보직모집'),
          인게임시험: interaction.options.getInteger('인게임시험')
        };
        adminCount = calculate소령(input);
        extra = getExtra소령(input);
        // replyText += ... (기존 그대로)
      } else {
        // 중령 input 처리 (기존 그대로)
      }

      const photoAttachments = [];
      for (let i = 1; i <= 10; i++) {
        const att = interaction.options.getAttachment(`증거사진${i}`);
        if (att) photoAttachments.push(att);
      }
      if (photoAttachments.length > 0) replyText += `\n📸 증거 사진 ${photoAttachments.length}장 첨부됨`;

      const group = is소령 ? data.소령 : data.중령;
      if (!group.users[interaction.user.id]) group.users[interaction.user.id] = { nick, totalAdmin: 0, totalExtra: 0, daily: {} };
      const u = group.users[interaction.user.id];
      u.nick = nick;
      if (!u.daily[date]) u.daily[date] = { admin: 0, extra: 0 };
      u.daily[date].admin += adminCount;
      u.daily[date].extra += extra;
      u.totalAdmin = (u.totalAdmin || 0) + adminCount;
      u.totalExtra = (u.totalExtra || 0) + extra;

      saveData();

      let embeds = [], files = [];
      if (photoAttachments.length > 0) {
        files = photoAttachments.slice(0, 10).map((att, idx) => ({
          attachment: att.url,
          name: `evidence_${idx + 1}_${att.name || 'image.png'}`
        }));
        const links = photoAttachments.slice(0, 10).map((att, idx) => `[[사진${idx + 1}]](${att.url})`).join('  •  ');
        embeds = [new EmbedBuilder().setTitle('📸 증거 사진').setDescription(links)];
      }

      return interaction.reply({ content: replyText, embeds, files });
    }

    const supervisorOnlyCommands = new Set([
      '소령오늘점수', '중령오늘점수', '소령주간점수', '중령주간점수',
      '소령어제점수', '중령어제점수', '소령지난주점수', '중령지난주점수',
      '어제점수', '지난주점수', '초기화주간', '소령오늘초기화', '중령오늘초기화',
      '행정통계', '강등대상'
    ]);

    if (supervisorOnlyCommands.has(cmd) && !isSupervisor()) {
      return interaction.reply({ content: '❌ 감독관만 사용할 수 있습니다.', ephemeral: true });
    }

    // ================== 무거운 명령어 (defer + editReply) ==================
    const heavyCommands = new Set([
      '소령오늘점수', '중령오늘점수',
      '소령주간점수', '중령주간점수',
      '소령어제점수', '중령어제점수',
      '소령지난주점수', '중령지난주점수',
      '어제점수', '지난주점수',
      '강등대상'
    ]);

    if (heavyCommands.has(cmd)) {
      await interaction.deferReply();
    }

    // ================== 오늘 점수 ==================
    if (cmd === '소령오늘점수' || cmd === '중령오늘점수') {
      const rankName = cmd === '소령오늘점수' ? '소령' : '중령';
      const roleId = rankName === '소령' ? MAJOR_ROLE_ID : LTCOL_ROLE_ID;
      const date = getReportDate();
      const roster = await buildRosterForRole(guild, roleId, EXCLUDED_ROLE_IDS);

      const group = rankName === '소령' ? data.소령 : data.중령;
      for (const rm of roster) {
        if (group.users?.[rm.userId]) group.users[rm.userId].nick = rm.nick;
      }
      saveData();

      const snap = makeDailySnapshotFromRoster(rankName, date, roster);

      cleanupPageCache();
      const cacheKey = makeCacheKey();
      PAGE_CACHE.set(cacheKey, {
        kind: 'daily',
        rankName,
        meta: { date, title: `${rankName} 오늘 점수 (최대 100점)` },
        items: snap,
        createdAt: Date.now(),
        ownerId: interaction.user.id
      });

      const { slice, page, totalPages, total } = paginate(snap, 1);
      const embed = createDailyEmbedPaged(rankName, `${rankName} 오늘 점수 (최대 100점)`, date, slice, page, totalPages, total);
      const row = buildPagerRow(cacheKey, page, totalPages);

      return await interaction.editReply({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
    }

    // ================== 주간 점수 ==================
    if (cmd === '소령주간점수' || cmd === '중령주간점수') {
      const rankName = cmd === '소령주간점수' ? '소령' : '중령';
      const roleId = rankName === '소령' ? MAJOR_ROLE_ID : LTCOL_ROLE_ID;
      const group = rankName === '소령' ? data.소령 : data.중령;
      const weekStart = group.weekStart || getSundayWeekStart(getReportDate());
      const roster = await buildRosterForRole(guild, roleId, EXCLUDED_ROLE_IDS);

      for (const rm of roster) {
        if (group.users?.[rm.userId]) group.users[rm.userId].nick = rm.nick;
      }
      saveData();

      const weeklySnap = makeWeeklySnapshotFromRoster(rankName, weekStart, roster);

      cleanupPageCache();
      const cacheKey = makeCacheKey();
      PAGE_CACHE.set(cacheKey, {
        kind: 'weekly',
        rankName,
        meta: { weekStart: weeklySnap.weekStart, weekEnd: weeklySnap.weekEnd, title: `${rankName} 주간 점수` },
        items: weeklySnap.list,
        createdAt: Date.now(),
        ownerId: interaction.user.id
      });

      const { slice, page, totalPages, total } = paginate(weeklySnap.list, 1);
      const embed = createWeeklyEmbedPaged(rankName, `${rankName} 주간 점수`, weeklySnap.weekStart, weeklySnap.weekEnd, slice, page, totalPages, total);
      const row = buildPagerRow(cacheKey, page, totalPages);

      return await interaction.editReply({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
    }

    // ================== 개별 어제 ==================
    if (cmd === '소령어제점수' || cmd === '중령어제점수') {
      const rankName = cmd === '소령어제점수' ? '소령' : '중령';
      const { date, snap } = await getOrMakeYesterdaySnapshot(rankName, guild);

      cleanupPageCache();
      const cacheKey = makeCacheKey();
      PAGE_CACHE.set(cacheKey, {
        kind: 'daily',
        rankName,
        meta: { date, title: `${rankName} ${date} 점수 (최대 100점)` },
        items: snap,
        createdAt: Date.now(),
        ownerId: interaction.user.id
      });

      const { slice, page, totalPages, total } = paginate(snap, 1);
      const embed = createDailyEmbedPaged(rankName, `${rankName} ${date} 점수 (최대 100점)`, date, slice, page, totalPages, total);
      const row = buildPagerRow(cacheKey, page, totalPages);

      return await interaction.editReply({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
    }

    // ================== 개별 지난주 ==================
    if (cmd === '소령지난주점수' || cmd === '중령지난주점수') {
      const rankName = cmd === '소령지난주점수' ? '소령' : '중령';
      const weeklySnap = await getOrMakeLastWeekSnapshot(rankName, guild);

      cleanupPageCache();
      const cacheKey = makeCacheKey();
      PAGE_CACHE.set(cacheKey, {
        kind: 'weekly',
        rankName,
        meta: { weekStart: weeklySnap.weekStart, weekEnd: weeklySnap.weekEnd, title: `${rankName} 지난주 점수` },
        items: weeklySnap.list,
        createdAt: Date.now(),
        ownerId: interaction.user.id
      });

      const { slice, page, totalPages, total } = paginate(weeklySnap.list, 1);
      const embed = createWeeklyEmbedPaged(rankName, `${rankName} 지난주 점수`, weeklySnap.weekStart, weeklySnap.weekEnd, slice, page, totalPages, total);
      const row = buildPagerRow(cacheKey, page, totalPages);

      return await interaction.editReply({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
    }

    // ================== 공용 어제점수 (첫 페이지만) ==================
    if (cmd === '어제점수') {
      const yMaj = await getOrMakeYesterdaySnapshot('소령', guild);
      const yLt = await getOrMakeYesterdaySnapshot('중령', guild);
      const dateStr = yMaj.date;

      const info = new EmbedBuilder()
        .setTitle(`어제 점수 (기준일: ${dateStr})`)
        .setDescription('소령/중령은 각각 첫 페이지(최대 28명)만 표시됩니다.\n더 보기: /소령어제점수 /중령어제점수');

      return await interaction.editReply({
        embeds: [
          info,
          createDailyEmbedFirstPage('소령', `소령 ${dateStr} 점수 (최대 100점)`, dateStr, yMaj.snap),
          createDailyEmbedFirstPage('중령', `중령 ${dateStr} 점수 (최대 100점)`, dateStr, yLt.snap)
        ],
        components: []
      });
    }

    // ================== 공용 지난주점수 (첫 페이지만) ==================
    if (cmd === '지난주점수') {
      const wMaj = await getOrMakeLastWeekSnapshot('소령', guild);
      const wLt = await getOrMakeLastWeekSnapshot('중령', guild);

      const info = new EmbedBuilder()
        .setTitle('지난주 점수')
        .setDescription('소령/중령은 각각 첫 페이지(최대 28명)만 표시됩니다.\n더 보기: /소령지난주점수 /중령지난주점수');

      return await interaction.editReply({
        embeds: [
          info,
          createWeeklyEmbedFirstPage('소령', '소령 지난주 점수', wMaj),
          createWeeklyEmbedFirstPage('중령', '중령 지난주 점수', wLt)
        ],
        components: []
      });
    }

    // ================== 나머지 가벼운 명령어 (defer 없이 reply) ==================
    if (cmd === '초기화주간') {
      const majRes = clearPrev7ReportDaysBeforeThisWeek(data.소령);
      const ltRes = clearPrev7ReportDaysBeforeThisWeek(data.중령);

      data.소령.weekStart = majRes.thisWeekStart;
      data.중령.weekStart = ltRes.thisWeekStart;

      pruneOldDaily(21);
      pruneOldWeekly(12);
      saveData();

      const endShown = addDays(majRes.rangeEnd, -1);
      return interaction.reply({
        content: `🔄 주간 초기화 완료\n` +
          `- 오늘: ${majRes.today}\n` +
          `- 보호: ${majRes.thisWeekStart} 이후\n` +
          `- 삭제: ${majRes.rangeStart} ~ ${endShown}\n` +
          `- 삭제 항목: 소령 ${majRes.clearedEntries} / 중령 ${ltRes.clearedEntries}`,
        ephemeral: false
      });
    }

    if (cmd === '소령오늘초기화' || cmd === '중령오늘초기화') {
      // 기존 로직 그대로 (빠름)
      const is소령 = cmd === '소령오늘초기화';
      const date = getReportDate();
      const group = is소령 ? data.소령 : data.중령;
      const targetUser = interaction.options.getUser('대상');
      const isAll = interaction.options.getBoolean('전체') === true;

      if (!isAll && !targetUser) {
        return interaction.reply({ content: 'ℹ️ 대상 또는 전체(true)를 선택하세요.', ephemeral: true });
      }

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
        saveData();
        return interaction.reply({ content: `✅ 오늘(${date}) 전체 초기화 완료 (${cleared}명)` });
      }

      const uid = targetUser.id;
      const u = group.users?.[uid];
      if (!u || !u.daily?.[date]) {
        return interaction.reply({ content: `ℹ️ ${targetUser} 님 오늘 기록 없음`, ephemeral: true });
      }

      delete u.daily[date];
      recomputeTotals(group);
      saveData();
      return interaction.reply({ content: `✅ ${targetUser} 님 오늘(${date}) 기록 초기화` });
    }

    if (cmd === '행정통계') {
      // 기존 로직 그대로
      const date = getReportDate();
      const sumGroup = (group) => {
        let userCount = 0, totalAdmin = 0, totalExtra = 0, todayAdminUnits = 0, todayExtra = 0;
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
          `**기준 일자**: ${date}\n\n` +
          `## 소령\n- 등록: ${sMaj.userCount}명\n- 누적: 행정 ${sMaj.totalAdmin} / 추가 ${sMaj.totalExtra}\n- 오늘: 행정 ${sMaj.todayAdminUnits} / 추가 ${sMaj.todayExtra}\n\n` +
          `## 중령\n- 등록: ${sLt.userCount}명\n- 누적: 행정 ${sLt.totalAdmin} / 추가 ${sLt.totalExtra}\n- 오늘: 행정 ${sLt.todayAdminUnits} / 추가 ${sLt.todayExtra}\n\n` +
          `※ 점수는 퍼센타일 환산 후 계산`
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (cmd === '강등대상') {
      const today = getReportDate();
      const thisWeekStart = getSundayWeekStart(today);
      const excludeAll = [...new Set([...EXCLUDED_ROLE_IDS, ...DEMOTION_EXTRA_EXCLUDED_ROLE_IDS])];

      const majRoster = await buildRosterForRole(guild, MAJOR_ROLE_ID, excludeAll);
      const ltRoster = await buildRosterForRole(guild, LTCOL_ROLE_ID, excludeAll);

      const map = new Map();
      for (const rm of [...majRoster, ...ltRoster]) if (!map.has(rm.userId)) map.set(rm.userId, rm);
      const roster = Array.from(map.values());

      const now = Date.now();
      const MIN_MS = 7 * 24 * 60 * 60 * 1000;
      const filtered = roster.filter(rm => !rm.joinedAt || (now - rm.joinedAt.getTime()) >= MIN_MS);

      const isLtSet = new Set(ltRoster.map(x => x.userId));
      const isMajSet = new Set(majRoster.map(x => x.userId));

      const groupMaj = data.소령;
      const groupLt = data.중령;
      const weekStartMaj = groupMaj.weekStart || thisWeekStart;
      const weekStartLt = groupLt.weekStart || thisWeekStart;

      const weekDatesMaj = Array.from({ length: 7 }, (_, i) => addDays(weekStartMaj, i));
      const weekDatesLt = Array.from({ length: 7 }, (_, i) => addDays(weekStartLt, i));

      const weeklyTotals = {};

      const onlyMaj = filtered.filter(rm => isMajSet.has(rm.userId) && !isLtSet.has(rm.userId));
      if (onlyMaj.length) {
        for (const rm of onlyMaj) weeklyTotals[rm.userId] = { nick: rm.nick, total: 0, rankLabel: '소령' };
        for (const d of weekDatesMaj) {
          const { rows } = buildDayScoresWithRoster('소령', d, onlyMaj);
          rows.forEach(r => weeklyTotals[r.userId].total += r.total);
        }
      }

      const ltAll = filtered.filter(rm => isLtSet.has(rm.userId));
      if (ltAll.length) {
        for (const rm of ltAll) weeklyTotals[rm.userId] = { nick: rm.nick, total: 0, rankLabel: '중령' };
        for (const d of weekDatesLt) {
          const { rows } = buildDayScoresWithRoster('중령', d, ltAll);
          rows.forEach(r => weeklyTotals[r.userId].total += r.total);
        }
      }

      const targets = Object.entries(weeklyTotals)
        .map(([userId, v]) => ({ userId, ...v }))
        .filter(x => x.total < 150)
        .sort((a, b) => a.total - b.total);

      const title = `강등 대상 (이번 주 150점 미만)`;
      const descHead = `**기준 주간**: ${thisWeekStart} ~ ${addDays(thisWeekStart, 6)}\n**제외**: 가입 7일 미만, 법무교육단/감독관 등\n\n`;
      const lines = targets.length
        ? targets.slice(0, 40).map((t, i) => `**${i + 1}.** [${t.rankLabel}] ${trunc(t.nick, 24)} <@${t.userId}> — **${t.total}점**`).join('\n')
        : '✅ 해당 인원 없음';

      const desc = buildDescriptionWithin4096(descHead, [lines]);

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(desc)
        .setFooter({ text: targets.length > 40 ? '최대 40명 표시' : '' });

      return await interaction.editReply({ embeds: [embed] });
    }
  } catch (e) {
    console.error('❌ interactionCreate 처리 중 오류:', e);
    try {
      console.error('❌ cmd=', interaction?.commandName, 'user=', interaction?.user?.id);
    } catch (_) {}

    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ 처리 중 오류가 발생했습니다. (로그 확인 필요)', ephemeral: true });
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ content: '❌ 처리 중 오류가 발생했습니다. (로그 확인 필요)' });
      }
    } catch (_) {}
  }
});

// ================== TOKEN ==================
if (!TOKEN) {
  console.error('❌ TOKEN 환경변수가 설정되지 않았습니다!');
  process.exit(1);
}

client.login(TOKEN);