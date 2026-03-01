// @ts-nocheck

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,

    // ✅ 역할 멤버 목록/가입일/표시명 조회 위해 필요
    GatewayIntentBits.GuildMembers
  ]
});

// ================== 설정 ==================
const TOKEN = process.env.TOKEN;
const GUILD_ID = '1018194815286001756';

// ✅ 감독관 역할 ID 여러 개 지원
const SUPERVISOR_ROLE_IDS = [
  '1018195904261529691',
  '1473688580613341419'
];

// ✅ 소령/중령 역할 ID
const MAJOR_ROLE_ID = '1472582859339596091';   // 소령 역할 ID
const LTCOL_ROLE_ID = '1018447060627894322';   // 중령 역할 ID

// ✅ (요청 #5) 점수 표시에 포함할 역할(보고 미제출이어도 표시)
const INCLUDE_ROLE_ID = '1018195906807480402';

// ✅ (요청 #4) 강등대상 제외 역할
const DEMOTION_EXCLUDE_ROLE_ID = '1477394729808298167';

// ================== 출력 설정 ==================
const PAGE_SIZE = 28; // 점수 출력/강등대상 출력 모두 28줄 기준 (embed 가독성)
const DEMOTION_THRESHOLD = 150;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'admin_data.json');

// ================== 데이터 구조 ==================
let data = {
  소령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' },
  중령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' }
};

// ================== 페이지 캐시(버튼 페이지네이션) ==================
// messageId -> { type, createdAt, ...payload }
const PAGE_CACHE = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15분
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of PAGE_CACHE.entries()) {
    if (!v?.createdAt || now - v.createdAt > CACHE_TTL_MS) PAGE_CACHE.delete(k);
  }
}, 60 * 1000);

// ================== 데이터 저장 ==================
function loadData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    saveData();
  }

  // 호환/안전
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

// ================== 주간(일요일 02시 기준) 유틸 ==================
function getSundayWeekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00+09:00`);
  const day = d.getUTCDay(); // 0=일
  return addDays(dateStr, -day);
}

// ================== 누적 정합성 ==================
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

// ================== /초기화주간 핵심 로직 ==================
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
  return (
    (input.권한지급 || 0) * 1 +
    (input.랭크변경 || 0) * 1 +
    (input.팀변경 || 0) * 1
  );
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
  return (
    (input.인게임시험 || 0) * 1 +
    (input.코호스트 || 0) * 1 +
    (input.피드백 || 0) * 2
  );
}

// ================== 퍼센타일 기반 배점 ==================
function getAdminPointsByPercentile(pct) {
  if (pct <= 10) return 70;
  if (pct <= 34) return 50;
  if (pct <= 66) return 40;
  if (pct <= 90) return 30;
  return 20;
}

// ================== roster(표시대상) 확보 ==================
async function getIncludeRoleNickMap(guild) {
  const map = new Map(); // userId -> displayName
  const role = await guild.roles.fetch(INCLUDE_ROLE_ID).catch(() => null);
  if (!role) return map;

  role.members.forEach(m => {
    map.set(m.id, m.displayName || m.user?.username || '알수없음');
  });

  return map;
}

function buildRoster(rankName, includeNickMap) {
  const group = rankName === '소령' ? data.소령 : data.중령;

  const rosterMap = new Map();

  // 1) 보고 제출자
  for (const [uid, u] of Object.entries(group.users || {})) {
    rosterMap.set(uid, {
      userId: uid,
      nick: u?.nick || '알수없음',
      dailyRef: u?.daily || null
    });
  }

  // 2) INCLUDE_ROLE 보유자
  for (const [uid, nick] of includeNickMap.entries()) {
    if (!rosterMap.has(uid)) {
      rosterMap.set(uid, { userId: uid, nick: nick || '알수없음', dailyRef: null });
    } else {
      const cur = rosterMap.get(uid);
      if (nick && (!cur.nick || cur.nick === '알수없음')) cur.nick = nick;
    }
  }

  return Array.from(rosterMap.values());
}

// ================== 일일 점수 계산(퍼센타일 개선 포함) ==================
function buildDayScoresFromRoster(rankName, dateStr, roster) {
  const is소령 = rankName === '소령';
  const minRequired = is소령 ? 3 : 4;

  const rows = (roster || []).map((r) => {
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
      percentile: null
    };
  });

  const eligible = rows.filter(x => x.meetsMin);
  eligible.sort((a, b) => b.adminUnits - a.adminUnits);

  const n = eligible.length;

  for (let i = 0; i < n; i++) {
    const cur = eligible[i];

    // 동점 그룹의 첫 인덱스
    let start = i;
    while (start > 0 && eligible[start - 1].adminUnits === cur.adminUnits) start--;

    // ✅ 개선된 "상위 %" : 1등(0) -> 1%
    const pct = Math.floor((start / n) * 100) + 1;

    cur.percentile = pct;
    cur.adminPoints = getAdminPointsByPercentile(pct);
    cur.extraPoints = Math.min(30, cur.extraRaw);
    cur.total = Math.min(100, cur.adminPoints + cur.extraPoints);
  }

  // 미달자
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

// ================== 주간 계산 최적화(캐시/재활용) ==================
function makeWeeklySnapshotOptimized(rankName, weekStart, roster) {
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const totals = new Map(); // userId -> { userId, nick, weeklyTotal }
  (roster || []).forEach(r => {
    totals.set(r.userId, { userId: r.userId, nick: r.nick || '알수없음', weeklyTotal: 0 });
  });

  const dayCache = new Map(); // dateStr -> rows
  for (const d of weekDates) {
    let dayRows = dayCache.get(d);
    if (!dayRows) {
      dayRows = buildDayScoresFromRoster(rankName, d, roster).rows;
      dayCache.set(d, dayRows);
    }
    dayRows.forEach(r => {
      if (!totals.has(r.userId)) totals.set(r.userId, { userId: r.userId, nick: r.nick, weeklyTotal: 0 });
      totals.get(r.userId).weeklyTotal += r.total;
    });
  }

  const list = Array.from(totals.values()).sort((a, b) => b.weeklyTotal - a.weeklyTotal);
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    list: list.map(x => ({ userId: x.userId, nick: x.nick, weeklyTotal: x.weeklyTotal }))
  };
}

// ================== 페이지네이션 공용 ==================
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function makeNavRow({ customPrefix, page, totalPages, disabledAll = false }) {
  const prev = new ButtonBuilder()
    .setCustomId(`${customPrefix}:prev`)
    .setLabel('이전')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabledAll || page <= 0);

  const next = new ButtonBuilder()
    .setCustomId(`${customPrefix}:next`)
    .setLabel('다음')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabledAll || page >= totalPages - 1);

  const pageInfo = new ButtonBuilder()
    .setCustomId(`${customPrefix}:info`)
    .setLabel(`${totalPages === 0 ? 0 : page + 1}/${Math.max(totalPages, 1)}`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(true);

  return new ActionRowBuilder().addComponents(prev, pageInfo, next);
}

// ================== 임베드 생성(오늘/주간) ==================
function createTodayPageEmbed(rankName, dateStr, pageRows, page, totalPages, totalCount) {
  const lines = pageRows.length
    ? pageRows.map((r, i) => {
      const idx = page * PAGE_SIZE + i + 1;
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

function createWeeklyPageEmbed(rankName, weekStart, weekEnd, pageRows, page, totalPages, totalCount) {
  const lines = pageRows.length
    ? pageRows.map((u, i) => {
      const idx = page * PAGE_SIZE + i + 1;
      return `**${idx}위** ${u.nick} — **${u.weeklyTotal}점**`;
    }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} 주간 점수`)
    .setDescription(
      `**주간 범위(새벽 2시 기준)**: ${weekStart} ~ ${weekEnd} (7일)\n` +
      `**표시 인원**: ${totalCount}명\n\n${lines}`
    )
    .setFooter({ text: `페이지 ${totalPages === 0 ? 0 : page + 1}/${Math.max(totalPages, 1)}` });
}

// ================== /강등대상 임베드 생성 ==================
function createDemotionEmbed(rankName, weekStart, weekEnd, pageRows, page, totalPages, totalCount) {
  const lines = pageRows.length
    ? pageRows.map((x, i) => {
      const idx = page * PAGE_SIZE + i + 1;
      return `**${idx}.** ${x.nick} <@${x.userId}> — **${x.weeklyTotal}점**`;
    }).join('\n')
    : '✅ 조건에 해당하는 인원이 없습니다.';

  return new EmbedBuilder()
    .setTitle(`강등 대상 [${rankName}] (주간 ${DEMOTION_THRESHOLD}점 미만)`)
    .setDescription(
      `**주간 범위(새벽 2시 기준)**: ${weekStart} ~ ${weekEnd}\n` +
      `**대상 인원**: ${totalCount}명\n\n` +
      lines
    )
    .setFooter({ text: `페이지 ${totalPages === 0 ? 0 : page + 1}/${Math.max(totalPages, 1)} | 제외: 가입 7일 미만, 역할(${DEMOTION_EXCLUDE_ROLE_ID})` });
}

// ================== 자동 초기화(스냅샷 저장) ==================
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

function runDailyAutoReset() {
  const y = getYesterdayDate();

  // 자동 스냅샷은 기존대로 보고제출자 중심 저장(용량 관리)
  const rosterMaj = Object.entries(data.소령.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));
  const rosterLt  = Object.entries(data.중령.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));

  const snapMaj = buildDayScoresFromRoster('소령', y, rosterMaj).display.map(r => ({
    userId: r.userId, nick: r.nick, total: r.total, adminPoints: r.adminPoints, extraPoints: r.extraPoints, percentile: r.percentile, meetsMin: r.meetsMin
  }));
  const snapLt = buildDayScoresFromRoster('중령', y, rosterLt).display.map(r => ({
    userId: r.userId, nick: r.nick, total: r.total, adminPoints: r.adminPoints, extraPoints: r.extraPoints, percentile: r.percentile, meetsMin: r.meetsMin
  }));

  data.소령.history.daily[y] = snapMaj;
  data.중령.history.daily[y] = snapLt;

  pruneOldDaily(21);
  saveData();
  console.log(`🧹 어제 스냅샷 저장 완료 (${y})`);
}

function runWeeklyAutoReset() {
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);
  const lastWeekStart = addDays(thisWeekStart, -7);

  const rosterMaj = Object.entries(data.소령.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));
  const rosterLt  = Object.entries(data.중령.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));

  data.소령.history.weekly[lastWeekStart] = makeWeeklySnapshotOptimized('소령', lastWeekStart, rosterMaj);
  data.중령.history.weekly[lastWeekStart] = makeWeeklySnapshotOptimized('중령', lastWeekStart, rosterLt);

  data.소령.lastWeekStart = lastWeekStart;
  data.중령.lastWeekStart = lastWeekStart;

  data.소령.weekStart = thisWeekStart;
  data.중령.weekStart = thisWeekStart;

  pruneOldWeekly(12);
  saveData();
  console.log(`🔄 주간 초기화 완료 (weekStart=${thisWeekStart}, lastWeekStart=${lastWeekStart})`);
}

// ================== 공용 조회(어제/지난주) ==================
function getOrMakeYesterdaySnapshot(rankName) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  const y = getYesterdayDate();
  let snap = group.history.daily[y];
  if (!snap) {
    const roster = Object.entries(group.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));
    snap = buildDayScoresFromRoster(rankName, y, roster).display.map(r => ({
      userId: r.userId, nick: r.nick, total: r.total, adminPoints: r.adminPoints, extraPoints: r.extraPoints, percentile: r.percentile, meetsMin: r.meetsMin
    }));
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
    const roster = Object.entries(group.users || {}).map(([uid, u]) => ({ userId: uid, nick: u?.nick, dailyRef: u?.daily || null }));
    weeklySnap = makeWeeklySnapshotOptimized(rankName, key, roster);
    group.history.weekly[key] = weeklySnap;
    group.lastWeekStart = key;
    saveData();
  }
  return weeklySnap;
}

// ================== (요청) 오늘/주간 "전체 출력" 페이지네이션 ==================
async function replyPaginatedToday(interaction, rankName) {
  const guild = interaction.guild;
  const dateStr = getReportDate();

  const includeNickMap = await getIncludeRoleNickMap(guild);
  const roster = buildRoster(rankName, includeNickMap);

  const { display } = buildDayScoresFromRoster(rankName, dateStr, roster);
  const pages = chunkArray(display, PAGE_SIZE);
  const totalPages = pages.length;
  const page = 0;

  const embed = createTodayPageEmbed(rankName, dateStr, pages[0] || [], page, totalPages, display.length);

  const prefix = `rank:today:${rankName}`;
  const row = makeNavRow({ customPrefix: prefix, page, totalPages, disabledAll: totalPages <= 1 });

  const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

  PAGE_CACHE.set(msg.id, {
    createdAt: Date.now(),
    type: 'rank_today',
    rankName,
    dateStr,
    display,     // full rows (includes totals etc.)
    page
  });
}

async function replyPaginatedWeekly(interaction, rankName) {
  const guild = interaction.guild;
  const group = rankName === '소령' ? data.소령 : data.중령;
  const weekStart = group.weekStart || getSundayWeekStart(getReportDate());

  const includeNickMap = await getIncludeRoleNickMap(guild);
  const roster = buildRoster(rankName, includeNickMap);

  const weeklySnap = makeWeeklySnapshotOptimized(rankName, weekStart, roster);
  const list = weeklySnap.list || [];

  const pages = chunkArray(list, PAGE_SIZE);
  const totalPages = pages.length;
  const page = 0;

  const embed = createWeeklyPageEmbed(rankName, weeklySnap.weekStart, weeklySnap.weekEnd, pages[0] || [], page, totalPages, list.length);

  const prefix = `rank:weekly:${rankName}`;
  const row = makeNavRow({ customPrefix: prefix, page, totalPages, disabledAll: totalPages <= 1 });

  const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

  PAGE_CACHE.set(msg.id, {
    createdAt: Date.now(),
    type: 'rank_weekly',
    rankName,
    weekStart: weeklySnap.weekStart,
    weekEnd: weeklySnap.weekEnd,
    list,
    page
  });
}

// ================== (요청) /강등대상 페이지네이션 + 임베드 2개 ==================
async function replyPaginatedDemotions(interaction) {
  const guild = interaction.guild;

  // 가입일/역할 확인 위해 전체 fetch (권장)
  await guild.members.fetch().catch(() => null);

  const now = new Date();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  const includeNickMap = await getIncludeRoleNickMap(guild);

  // 소령/중령 각각 주간 계산(표시대상: 보고제출자 + include-role)
  const majWeekStart = data.소령.weekStart || getSundayWeekStart(getReportDate());
  const ltWeekStart  = data.중령.weekStart || getSundayWeekStart(getReportDate());

  const rosterMaj = buildRoster('소령', includeNickMap);
  const rosterLt  = buildRoster('중령', includeNickMap);

  const weeklyMaj = makeWeeklySnapshotOptimized('소령', majWeekStart, rosterMaj);
  const weeklyLt  = makeWeeklySnapshotOptimized('중령', ltWeekStart, rosterLt);

  const weeklyMapMaj = new Map((weeklyMaj.list || []).map(x => [x.userId, x.weeklyTotal]));
  const weeklyMapLt  = new Map((weeklyLt.list || []).map(x => [x.userId, x.weeklyTotal]));

  // 대상은 "소령 역할 보유자"와 "중령 역할 보유자" 각각
  const demoteMaj = [];
  const demoteLt = [];

  for (const member of guild.members.cache.values()) {
    // 제외1) 가입 7일 미만
    const joined = member.joinedAt ? member.joinedAt.getTime() : null;
    if (joined && (now.getTime() - joined) < sevenDaysMs) continue;

    // 제외2) 제외 역할
    if (member.roles.cache.has(DEMOTION_EXCLUDE_ROLE_ID)) continue;

    const nick = member.displayName || member.user?.username || '알수없음';

    if (member.roles.cache.has(MAJOR_ROLE_ID)) {
      const weeklyTotal = weeklyMapMaj.get(member.id) ?? 0;
      if (weeklyTotal < DEMOTION_THRESHOLD) demoteMaj.push({ userId: member.id, nick, weeklyTotal });
    }

    if (member.roles.cache.has(LTCOL_ROLE_ID)) {
      const weeklyTotal = weeklyMapLt.get(member.id) ?? 0;
      if (weeklyTotal < DEMOTION_THRESHOLD) demoteLt.push({ userId: member.id, nick, weeklyTotal });
    }
  }

  demoteMaj.sort((a, b) => a.weeklyTotal - b.weeklyTotal);
  demoteLt.sort((a, b) => a.weeklyTotal - b.weeklyTotal);

  const pagesMaj = chunkArray(demoteMaj, PAGE_SIZE);
  const pagesLt = chunkArray(demoteLt, PAGE_SIZE);

  const pMaj = 0;
  const pLt = 0;

  const eMaj = createDemotionEmbed('소령', weeklyMaj.weekStart, weeklyMaj.weekEnd, pagesMaj[pMaj] || [], pMaj, pagesMaj.length, demoteMaj.length);
  const eLt  = createDemotionEmbed('중령', weeklyLt.weekStart, weeklyLt.weekEnd, pagesLt[pLt] || [], pLt, pagesLt.length, demoteLt.length);

  const rowMaj = makeNavRow({ customPrefix: 'demote:maj', page: pMaj, totalPages: pagesMaj.length, disabledAll: pagesMaj.length <= 1 });
  const rowLt  = makeNavRow({ customPrefix: 'demote:lt', page: pLt, totalPages: pagesLt.length, disabledAll: pagesLt.length <= 1 });

  const msg = await interaction.reply({
    embeds: [eMaj, eLt],
    components: [rowMaj, rowLt],
    fetchReply: true
  });

  PAGE_CACHE.set(msg.id, {
    createdAt: Date.now(),
    type: 'demotions',
    maj: { weekStart: weeklyMaj.weekStart, weekEnd: weeklyMaj.weekEnd, list: demoteMaj, page: pMaj },
    lt:  { weekStart: weeklyLt.weekStart,  weekEnd: weeklyLt.weekEnd,  list: demoteLt,  page: pLt }
  });
}

// ================== 버튼 처리 ==================
async function handlePaginationButton(interaction) {
  const msgId = interaction.message?.id;
  const state = PAGE_CACHE.get(msgId);
  if (!state) {
    // 캐시 만료 등
    return interaction.reply({ content: '⚠️ 페이지 정보가 만료되었습니다. 명령어를 다시 실행해 주세요.', ephemeral: true });
  }

  const id = interaction.customId; // e.g. "rank:today:소령:next" 또는 "demote:maj:prev"
  const parts = id.split(':');

  // rank pagination
  if (parts[0] === 'rank' && (state.type === 'rank_today' || state.type === 'rank_weekly')) {
    const mode = parts[1]; // today/weekly
    const rankName = parts[2]; // 소령/중령
    const action = parts[3]; // prev/next/info

    if (action === 'info') return interaction.deferUpdate();

    if (state.rankName !== rankName) return interaction.deferUpdate();

    if (state.type === 'rank_today' && mode === 'today') {
      const pages = chunkArray(state.display, PAGE_SIZE);
      const totalPages = pages.length;
      let page = state.page || 0;

      if (action === 'prev') page = Math.max(0, page - 1);
      if (action === 'next') page = Math.min(totalPages - 1, page + 1);

      state.page = page;

      const embed = createTodayPageEmbed(rankName, state.dateStr, pages[page] || [], page, totalPages, state.display.length);
      const row = makeNavRow({ customPrefix: `rank:today:${rankName}`, page, totalPages, disabledAll: totalPages <= 1 });

      return interaction.update({ embeds: [embed], components: [row] });
    }

    if (state.type === 'rank_weekly' && mode === 'weekly') {
      const pages = chunkArray(state.list, PAGE_SIZE);
      const totalPages = pages.length;
      let page = state.page || 0;

      if (action === 'prev') page = Math.max(0, page - 1);
      if (action === 'next') page = Math.min(totalPages - 1, page + 1);

      state.page = page;

      const embed = createWeeklyPageEmbed(rankName, state.weekStart, state.weekEnd, pages[page] || [], page, totalPages, state.list.length);
      const row = makeNavRow({ customPrefix: `rank:weekly:${rankName}`, page, totalPages, disabledAll: totalPages <= 1 });

      return interaction.update({ embeds: [embed], components: [row] });
    }

    return interaction.deferUpdate();
  }

  // demotions pagination (two rows)
  if (parts[0] === 'demote' && state.type === 'demotions') {
    const which = parts[1]; // maj/lt
    const action = parts[2]; // prev/next/info
    if (action === 'info') return interaction.deferUpdate();

    const slot = which === 'maj' ? state.maj : state.lt;
    const rankName = which === 'maj' ? '소령' : '중령';

    const pages = chunkArray(slot.list, PAGE_SIZE);
    const totalPages = pages.length;
    let page = slot.page || 0;

    if (action === 'prev') page = Math.max(0, page - 1);
    if (action === 'next') page = Math.min(Math.max(totalPages - 1, 0), page + 1);

    slot.page = page;

    // 기존 메시지는 임베드 2개이므로 둘 다 다시 구성
    const majPages = chunkArray(state.maj.list, PAGE_SIZE);
    const ltPages  = chunkArray(state.lt.list, PAGE_SIZE);

    const eMaj = createDemotionEmbed(
      '소령',
      state.maj.weekStart,
      state.maj.weekEnd,
      majPages[state.maj.page] || [],
      state.maj.page,
      majPages.length,
      state.maj.list.length
    );

    const eLt = createDemotionEmbed(
      '중령',
      state.lt.weekStart,
      state.lt.weekEnd,
      ltPages[state.lt.page] || [],
      state.lt.page,
      ltPages.length,
      state.lt.list.length
    );

    const rowMaj = makeNavRow({ customPrefix: 'demote:maj', page: state.maj.page, totalPages: majPages.length, disabledAll: majPages.length <= 1 });
    const rowLt  = makeNavRow({ customPrefix: 'demote:lt',  page: state.lt.page,  totalPages: ltPages.length,  disabledAll: ltPages.length <= 1 });

    return interaction.update({ embeds: [eMaj, eLt], components: [rowMaj, rowLt] });
  }

  return interaction.deferUpdate();
}

// ================== 명령어 등록 ==================
async function registerCommands() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return console.log('서버를 찾을 수 없습니다.');

  // ✅ 닉네임은 선택(미입력 시 displayName 자동 저장)
  const 소령Command = new SlashCommandBuilder()
    .setName('소령행정보고').setDescription('소령 행정 보고서 (소령 전용)')
    .addStringOption(o => o.setName('닉네임').setDescription('닉네임 (미입력 시 서버 표시명 자동 사용)').setRequired(false))
    .addIntegerOption(o => o.setName('권한지급').setDescription('권한 지급 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('랭크변경').setDescription('랭크 변경 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('팀변경').setDescription('팀 변경 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('보직모집').setDescription('보직 가입 요청·모집 시험 : n건 (추가 2점/건)').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건 (추가 1점/건)').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    소령Command.addAttachmentOption(o =>
      o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false)
    );
  }

  const 중령Command = new SlashCommandBuilder()
    .setName('중령행정보고').setDescription('중령 행정 보고서 (중령 전용)')
    .addStringOption(o => o.setName('닉네임').setDescription('닉네임 (미입력 시 서버 표시명 자동 사용)').setRequired(false))
    .addIntegerOption(o => o.setName('역할지급').setDescription('역할 지급 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인증').setDescription('인증 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('서버역할').setDescription('서버 역할 요청 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('감찰').setDescription('행정 감찰 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('코호스트').setDescription('인게임 코호스트 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('피드백').setDescription('피드백 제공 : n건').setRequired(true));

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

    // ✅ /강등대상
    new SlashCommandBuilder().setName('강등대상').setDescription('이번 주 주간 점수 150점 미만 인원 표시 (감독관 전용)')
  ]);

  console.log('✅ 명령어 등록 완료');
}

// ================== 이벤트 ==================
client.once('ready', async () => {
  console.log(`${client.user.tag} 준비 완료!`);
  loadData();

  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);

  if (!data.소령.weekStart) data.소령.weekStart = thisWeekStart;
  if (!data.중령.weekStart) data.중령.weekStart = thisWeekStart;
  saveData();

  await registerCommands();

  cron.schedule('0 2 * * *', () => runDailyAutoReset(), { timezone: 'Asia/Seoul' });
  cron.schedule('0 2 * * 0', () => runWeeklyAutoReset(), { timezone: 'Asia/Seoul' });

  console.log('⏰ 자동 스냅샷/초기화 스케줄 등록 완료 (매일 02:00 / 매주 일 02:00)');
});

client.on('interactionCreate', async interaction => {
  // 버튼 먼저 처리
  if (interaction.isButton()) {
    return handlePaginationButton(interaction);
  }

  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  const hasRole = (roleId) => interaction.member?.roles?.cache?.has(roleId);
  const isSupervisor = () => interaction.member?.roles?.cache?.some(r => SUPERVISOR_ROLE_IDS.includes(r.id));
  const isMajor = () => hasRole(MAJOR_ROLE_ID);
  const isLtCol = () => hasRole(LTCOL_ROLE_ID);

  // ================== 보고서(역할 제한) ==================
  if (cmd === '소령행정보고' && !isMajor()) {
    return interaction.reply({ content: '❌ 이 명령어는 **소령 역할**만 사용할 수 있습니다.', ephemeral: true });
  }
  if (cmd === '중령행정보고' && !isLtCol()) {
    return interaction.reply({ content: '❌ 이 명령어는 **중령 역할**만 사용할 수 있습니다.', ephemeral: true });
  }

  // ================== 감독관 전용 ==================
  const supervisorOnlyCmds = new Set([
    '소령오늘점수', '중령오늘점수', '소령주간점수', '중령주간점수',
    '소령어제점수', '중령어제점수', '소령지난주점수', '중령지난주점수',
    '어제점수', '지난주점수',
    '초기화주간', '소령오늘초기화', '중령오늘초기화',
    '행정통계',
    '강등대상'
  ]);

  if (supervisorOnlyCmds.has(cmd)) {
    if (!isSupervisor()) {
      return interaction.reply({ content: '❌ 감독관만 사용할 수 있습니다.', ephemeral: true });
    }
  }

  // ================== 보고서 ==================
  if (cmd === '소령행정보고' || cmd === '중령행정보고') {
    const is소령 = cmd === '소령행정보고';

    const inputNick = interaction.options.getString('닉네임');
    const autoNick = interaction.member?.displayName || interaction.user.username;
    const nick = (inputNick && inputNick.trim()) ? inputNick.trim() : autoNick;

    const date = getReportDate();

    let adminCount = 0, extra = 0;

    // ✅ (요청 #4) 닉네임 줄에 "본인 자동 멘션" 포함
    let replyText =
      `✅ **${is소령 ? '소령' : '중령'} 보고 완료!**\n` +
      `**닉네임**: <@${interaction.user.id}> (${nick})\n` +
      `**일자**: ${date}\n\n`;

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

      replyText += `**권한지급**(행정): ${input.권한지급}건\n`;
      replyText += `**랭크변경**(행정): ${input.랭크변경}건\n`;
      replyText += `**팀변경**(행정): ${input.팀변경}건\n`;
      replyText += `**보직 가입 요청·모집 시험**(추가 2점/건): ${input.보직모집}건\n`;
      replyText += `**인게임 시험**(추가 1점/건): ${input.인게임시험}건\n`;
    } else {
      const input = {
        역할지급: interaction.options.getInteger('역할지급'),
        인증: interaction.options.getInteger('인증'),
        서버역할: interaction.options.getInteger('서버역할'),
        감찰: interaction.options.getInteger('감찰'),
        인게임시험: interaction.options.getInteger('인게임시험'),
        코호스트: interaction.options.getInteger('코호스트'),
        피드백: interaction.options.getInteger('피드백')
      };

      adminCount = calculate중령(input);
      extra = getExtra중령(input);

      replyText += `**역할지급**(행정): ${input.역할지급}건\n`;
      replyText += `**인증**(행정): ${input.인증}건\n`;
      replyText += `**서버 역할 요청**(행정): ${input.서버역할}건\n`;
      replyText += `**행정 감찰**(행정): ${input.감찰}건\n`;
      replyText += `**인게임 시험**(추가): ${input.인게임시험}건\n`;
      replyText += `**인게임 코호스트**(추가): ${input.코호스트}건\n`;
      replyText += `**피드백 제공**(추가): ${input.피드백}건\n`;
    }

    // 첨부 사진 수집
    const photoAttachments = [];
    for (let i = 1; i <= 10; i++) {
      const att = interaction.options.getAttachment(`증거사진${i}`);
      if (att) photoAttachments.push(att);
    }
    if (photoAttachments.length > 0) replyText += `\n📸 증거 사진 ${photoAttachments.length}장 첨부됨`;

    // 데이터 저장
    const group = is소령 ? data.소령 : data.중령;
    if (!group.users[interaction.user.id]) group.users[interaction.user.id] = { nick, totalAdmin: 0, totalExtra: 0, daily: {} };
    const u = group.users[interaction.user.id];

    // 저장 닉네임은 displayName 기반으로 유지(나중에 점수표 표시용)
    u.nick = nick;

    if (!u.daily[date]) u.daily[date] = { admin: 0, extra: 0 };

    u.daily[date].admin += adminCount;
    u.daily[date].extra += extra;

    u.totalAdmin += adminCount;
    u.totalExtra += extra;

    saveData();

    // ✅ 사진: files 첨부 + 링크 임베드
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

      embeds = [
        new EmbedBuilder()
          .setTitle('📸 증거 사진')
          .setDescription(links)
      ];
    }

    await interaction.reply({
      content: replyText,
      embeds,
      files,
      ephemeral: false
    });
    return;
  }

  // ================== 오늘/주간(페이지네이션 포함) ==================
  if (cmd === '소령오늘점수' || cmd === '중령오늘점수') {
    const rankName = cmd === '소령오늘점수' ? '소령' : '중령';
    return replyPaginatedToday(interaction, rankName);
  }

  if (cmd === '소령주간점수' || cmd === '중령주간점수') {
    const rankName = cmd === '소령주간점수' ? '소령' : '중령';
    return replyPaginatedWeekly(interaction, rankName);
  }

  // ================== 어제/지난주(기존 방식 유지) ==================
  if (cmd === '소령어제점수' || cmd === '중령어제점수') {
    const rankName = cmd === '소령어제점수' ? '소령' : '중령';
    const { date, snap } = getOrMakeYesterdaySnapshot(rankName);

    const top = (snap || []).slice(0, PAGE_SIZE);
    const lines = top.length
      ? top.map((r, i) => {
        const minText = r.meetsMin ? '' : ' (최소업무 미달)';
        const pctText = r.percentile ? ` / 상위 ${r.percentile}%` : '';
        return `**${i + 1}위** ${r.nick} — **${r.total}점** 〔행정: ${r.adminPoints}${pctText} / 추가: ${r.extraPoints}${minText}〕`;
      }).join('\n')
      : '데이터가 없습니다.';

    const embed = new EmbedBuilder()
      .setTitle(`${rankName} ${date} 점수 (최대 100점)`)
      .setDescription(lines)
      .setFooter({ text: '최소업무 미달자는 0점 + 퍼센트 산정에서 제외' });

    return interaction.reply({ embeds: [embed] });
  }

  if (cmd === '소령지난주점수' || cmd === '중령지난주점수') {
    const rankName = cmd === '소령지난주점수' ? '소령' : '중령';
    const weeklySnap = getOrMakeLastWeekSnapshot(rankName);

    const list = (weeklySnap.list || []).slice(0, PAGE_SIZE);
    const lines = list.length
      ? list.map((u, i) => `**${i + 1}위** ${u.nick} — **${u.weeklyTotal}점**`).join('\n')
      : '데이터가 없습니다.';

    const embed = new EmbedBuilder()
      .setTitle(`${rankName} 지난주 점수`)
      .setDescription(`**주간 범위(새벽 2시 기준)**: ${weeklySnap.weekStart} ~ ${weeklySnap.weekEnd} (7일)\n\n${lines}`)
      .setFooter({ text: '주간=일~토(7일) 합산 / 일일 행정점수는 퍼센트 기준' });

    return interaction.reply({ embeds: [embed] });
  }

  // 공용: 어제점수
  if (cmd === '어제점수') {
    const yMaj = getOrMakeYesterdaySnapshot('소령');
    const yLt = getOrMakeYesterdaySnapshot('중령');

    const embed = new EmbedBuilder()
      .setTitle(`어제 점수 (기준일: ${yMaj.date})`)
      .setDescription('아래 임베드 2개로 소령/중령을 각각 표시합니다.');

    const mkEmbed = (rankName, dateStr, snap) => {
      const top = (snap || []).slice(0, PAGE_SIZE);
      const lines = top.length
        ? top.map((r, i) => {
          const minText = r.meetsMin ? '' : ' (최소업무 미달)';
          const pctText = r.percentile ? ` / 상위 ${r.percentile}%` : '';
          return `**${i + 1}위** ${r.nick} — **${r.total}점** 〔행정: ${r.adminPoints}${pctText} / 추가: ${r.extraPoints}${minText}〕`;
        }).join('\n')
        : '데이터가 없습니다.';

      return new EmbedBuilder()
        .setTitle(`${rankName} ${dateStr} 점수`)
        .setDescription(lines);
    };

    return interaction.reply({
      embeds: [
        embed,
        mkEmbed('소령', yMaj.date, yMaj.snap),
        mkEmbed('중령', yLt.date, yLt.snap)
      ]
    });
  }

  // 공용: 지난주점수
  if (cmd === '지난주점수') {
    const wMaj = getOrMakeLastWeekSnapshot('소령');
    const wLt = getOrMakeLastWeekSnapshot('중령');

    const embed = new EmbedBuilder()
      .setTitle('지난주 점수')
      .setDescription('아래 임베드 2개로 소령/중령을 각각 표시합니다.');

    const mkWeekly = (rankName, weeklySnap) => {
      const list = (weeklySnap.list || []).slice(0, PAGE_SIZE);
      const lines = list.length
        ? list.map((u, i) => `**${i + 1}위** ${u.nick} — **${u.weeklyTotal}점**`).join('\n')
        : '데이터가 없습니다.';

      return new EmbedBuilder()
        .setTitle(`${rankName} 지난주 점수`)
        .setDescription(`**주간 범위(새벽 2시 기준)**: ${weeklySnap.weekStart} ~ ${weeklySnap.weekEnd} (7일)\n\n${lines}`);
    };

    return interaction.reply({
      embeds: [
        embed,
        mkWeekly('소령', wMaj),
        mkWeekly('중령', wLt)
      ]
    });
  }

  // /초기화주간
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

  // 오늘 기록 초기화
  if (cmd === '소령오늘초기화' || cmd === '중령오늘초기화') {
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

      return interaction.reply({ content: `✅ 오늘(${date}) 기록 전체 초기화 완료 (${cleared}명)`, ephemeral: false });
    }

    const uid = targetUser.id;
    const u = group.users?.[uid];
    if (!u || !u.daily || !u.daily[date]) {
      return interaction.reply({ content: `ℹ️ ${targetUser} 님은 오늘(${date}) 기록이 없습니다.`, ephemeral: true });
    }

    delete u.daily[date];

    recomputeTotals(group);
    saveData();

    return interaction.reply({ content: `✅ ${targetUser} 님의 오늘(${date}) 기록을 초기화했습니다.`, ephemeral: false });
  }

  // 행정통계(원자료)
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
        `- 등록 인원(보고제출자): ${sMaj.userCount}명\n` +
        `- 누적(원자료): 행정(건수) ${sMaj.totalAdmin} / 추가(점수) ${sMaj.totalExtra}\n` +
        `- 오늘(원자료): 행정(건수) ${sMaj.todayAdminUnits} / 추가(점수) ${sMaj.todayExtra}\n\n` +
        `## 중령\n` +
        `- 등록 인원(보고제출자): ${sLt.userCount}명\n` +
        `- 누적(원자료): 행정(건수) ${sLt.totalAdmin} / 추가(점수) ${sLt.totalExtra}\n` +
        `- 오늘(원자료): 행정(건수) ${sLt.todayAdminUnits} / 추가(점수) ${sLt.todayExtra}\n\n` +
        `※ 오늘/주간 점수 표시에는 역할(${INCLUDE_ROLE_ID}) 보유자도 포함됩니다.`
      );

    return interaction.reply({ embeds: [embed] });
  }

  // ✅ /강등대상: 임베드 2개 + 각자 페이지네이션
  if (cmd === '강등대상') {
    return replyPaginatedDemotions(interaction);
  }
});

// ================== TOKEN 체크 ==================
if (!TOKEN) {
  console.log('❌ TOKEN이 설정되지 않았습니다! (.env 또는 환경변수 TOKEN 확인)');
  process.exit(1);
}

client.login(TOKEN);