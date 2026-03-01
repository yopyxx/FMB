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

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'admin_data.json');

// ================== 데이터 구조 ==================
// group = { weekStart, users, history:{daily,weekly}, lastWeekStart }
// users[userId] = { nick, totalAdmin, totalExtra, daily:{ [date]:{admin,extra} } }
// history.daily[date] = [{ userId,nick,total,adminPoints,extraPoints,percentile,meetsMin }]
// history.weekly[weekStart] = { weekStart, weekEnd, list:[{userId,nick,weeklyTotal}] }
let data = {
  소령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' },
  중령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' }
};

// ================== 런타임 캐시(성능) ==================
// 프로세스 재시작하면 초기화됨(정상). 같은 날짜 반복 계산을 줄여줌.
const dayTotalsCache = new Map(); // key: `${rankName}|${dateStr}` -> Map(userId->total)

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

  // 데이터 로드 후 캐시 무효화
  dayTotalsCache.clear();
}

function saveData() {
  // ✅ 저장 시에도 디렉토리 보장
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ================== 날짜 (새벽 2시 기준) ==================
// "KST에서 새벽 2시 이전"은 전날 보고로 취급하여 YYYY-MM-DD 키로 저장
function getReportDate() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST
  if (now.getHours() < 2) now.setDate(now.getDate() - 1);
  return now.toISOString().split('T')[0];
}

// YYYY-MM-DD에 일수 더하기 (비교/키 용도: UTC 자정 기준으로 계산해도 안전)
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getYesterdayDate() {
  return addDays(getReportDate(), -1);
}

// ================== 주간(일요일 02시 기준) 유틸 ==================
// ⚠️ 타임존/UTC 섞임으로 일요일 계산이 월요일로 밀리는 이슈 방지:
// KST 정오(12:00, +09:00) 기준으로 요일을 구하면 날짜 밀림 위험이 매우 낮음.
function getSundayWeekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00+09:00`);
  const day = d.getUTCDay(); // 0=일,1=월,...
  return addDays(dateStr, -day); // 해당 주 일요일(YYYY-MM-DD)
}

// ================== 누적 정합성(중요) ==================
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
  const thisWeekStart = getSundayWeekStart(today); // 이번 주 일요일(YYYY-MM-DD)

  // 삭제 구간: [이번 주 일요일 - 7일, 이번 주 일요일)
  const rangeStart = addDays(thisWeekStart, -7);
  const rangeEnd = thisWeekStart; // 미포함

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
// ✅ 소령 보직모집은 추가점수(2점/건)
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

// ================== 퍼센타일(상위 X%) 정의 개선 ==================
// ✅ "상위 X%"를 인원 적어도 자연스럽게 보이도록: 순위를 1~100으로 선형 정규화
function getTopPercentFromRank(rank, n) {
  if (n <= 1) return 1;
  // rank: 1..n  →  1..100
  return Math.round(((rank - 1) / (n - 1)) * 99) + 1;
}

// ================== 퍼센테이지 기반 배점 ==================
function getAdminPointsByPercentile(pct) {
  if (pct <= 10) return 70;
  if (pct <= 34) return 50;
  if (pct <= 66) return 40;
  if (pct <= 90) return 30;
  return 20;
}

// ================== 일일 점수 계산(미달자 제외 + 퍼센트) ==================
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

  // 퍼센트 산정 대상: 최소업무 충족자만
  const eligible = rows.filter(r => r.meetsMin);
  eligible.sort((a, b) => b.adminUnits - a.adminUnits);

  const n = eligible.length;

  for (let i = 0; i < n; i++) {
    const cur = eligible[i];

    // 동점 처리: 같은 adminUnits면 같은 퍼센트(가장 앞 rank 기준)
    let start = i;
    while (start > 0 && eligible[start - 1].adminUnits === cur.adminUnits) start--;

    const rank = start + 1;
    const pct = getTopPercentFromRank(rank, n);

    cur.percentile = pct;
    cur.adminPoints = getAdminPointsByPercentile(pct);
    cur.extraPoints = Math.min(30, cur.extraRaw);
    cur.total = Math.min(100, cur.adminPoints + cur.extraPoints);
  }

  // 최소업무 미달자: 0점 + 퍼센트 제외
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

// ================== (최적화) 해당 날짜 total만 빠르게 계산 + 캐시 ==================
function getDayTotalsOnly(rankName, dateStr) {
  const cacheKey = `${rankName}|${dateStr}`;
  const cached = dayTotalsCache.get(cacheKey);
  if (cached) return cached;

  const is소령 = rankName === '소령';
  const minRequired = is소령 ? 3 : 4;
  const group = is소령 ? data.소령 : data.중령;

  // 1) 각 유저 adminUnits/extraRaw 수집
  const rows = Object.entries(group.users || {}).map(([userId, u]) => {
    const adminUnits = u?.daily?.[dateStr]?.admin ?? 0;
    const extraRaw = u?.daily?.[dateStr]?.extra ?? 0;
    const meetsMin = adminUnits >= minRequired;
    return { userId, adminUnits, extraRaw, meetsMin };
  });

  // 2) eligible(최소업무 충족자)만 순위 산정
  const eligible = rows.filter(r => r.meetsMin);
  eligible.sort((a, b) => b.adminUnits - a.adminUnits);

  const n = eligible.length;
  const totalsMap = new Map();

  // 3) eligible 점수 부여
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

  // 4) 미달자는 0점
  for (const r of rows) {
    if (!totalsMap.has(r.userId)) totalsMap.set(r.userId, 0);
  }

  dayTotalsCache.set(cacheKey, totalsMap);
  return totalsMap;
}

// ================== 스냅샷 ==================
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

  // ✅ 일요일~토요일 7일
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const totals = {};

  for (const [uid, u] of Object.entries(group.users || {})) {
    totals[uid] = { userId: uid, nick: u?.nick || '알수없음', weeklyTotal: 0 };
  }

  // ✅ 최적화: totals-only + 캐시
  for (const d of weekDates) {
    const totalsMap = getDayTotalsOnly(rankName, d);
    for (const [uid, t] of totalsMap.entries()) {
      if (!totals[uid]) totals[uid] = { userId: uid, nick: group.users?.[uid]?.nick || '알수없음', weeklyTotal: 0 };
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

// ================== Embed ==================
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
    .setDescription(lines)
    .setFooter({ text: '최소업무 미달자는 0점 + 퍼센트 산정에서 제외' });
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
    .setDescription(`**일자**: ${date}\n\n${lines}`)
    .setFooter({ text: '최소업무 미달자는 0점 + 퍼센트 산정에서 제외' });
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
    .setDescription(`**주간 범위(새벽 2시 기준)**: ${weeklySnap.weekStart} ~ ${weeklySnap.weekEnd} (7일)\n\n${lines}`)
    .setFooter({ text: '주간=일~토(7일) 합산 / 일일 행정점수는 퍼센트 기준' });
}

function createWeeklyRankingEmbed(rankName) {
  const is소령 = rankName === '소령';
  const group = is소령 ? data.소령 : data.중령;

  // weekStart가 없으면 "이번 주 일요일"로
  const weekStart = group.weekStart || getSundayWeekStart(getReportDate());
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const totals = {};
  for (const [uid, u] of Object.entries(group.users || {})) {
    totals[uid] = { nick: u?.nick || '알수없음', weeklyTotal: 0 };
  }

  // ✅ 최적화: totals-only + 캐시
  for (const d of weekDates) {
    const totalsMap = getDayTotalsOnly(rankName, d);
    for (const [uid, t] of totalsMap.entries()) {
      if (!totals[uid]) totals[uid] = { nick: group.users?.[uid]?.nick || '알수없음', weeklyTotal: 0 };
      totals[uid].weeklyTotal += t;
    }
  }

  const list = Object.values(totals)
    .sort((a, b) => b.weeklyTotal - a.weeklyTotal)
    .slice(0, 28);

  const lines = list.length
    ? list.map((u, i) => `**${i + 1}위** ${u.nick} — **${u.weeklyTotal}점**`).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} 주간 점수`)
    .setDescription(`**주간 범위(새벽 2시 기준)**: ${weekStart} ~ ${addDays(weekStart, 6)} (7일)\n\n${lines}`)
    .setFooter({ text: '주간=일~토(7일) 합산 / 일일 행정점수는 퍼센트 기준' });
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

  // 오래된 것 삭제 후 캐시도 안전하게 비움(간단/확실)
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

function runDailyAutoReset() {
  const y = getYesterdayDate();
  data.소령.history.daily[y] = makeDailySnapshot('소령', y);
  data.중령.history.daily[y] = makeDailySnapshot('중령', y);

  pruneOldDaily(21);
  saveData();
  console.log(`🧹 어제 스냅샷 저장 완료 (${y})`);
}

// ✅ 주간 자동 초기화: 일요일 02시 기준(일요일~토요일)
// (주의) 자동 초기화는 범위 갱신/스냅샷 저장 용도로 유지.
// 실제 데이터 삭제는 수동 /초기화주간에서만 수행(운영상 안전)
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

// ================== 공용 조회(어제/지난주) ==================
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

// ================== 명령어 등록 ==================
async function registerCommands() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return console.log('서버를 찾을 수 없습니다.');

  // ✅ 닉네임 입력칸 제거 (보고자는 자동 멘션으로 저장/표시)
  const 소령Command = new SlashCommandBuilder()
    .setName('소령행정보고').setDescription('소령 행정 보고서 (소령 전용)')
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

    // 오늘/주간
    new SlashCommandBuilder().setName('소령오늘점수').setDescription('소령 오늘 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령오늘점수').setDescription('중령 오늘 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('소령주간점수').setDescription('소령 주간 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령주간점수').setDescription('중령 주간 점수 (감독관 전용)'),

    // ✅ 개별(기존 호환)
    new SlashCommandBuilder().setName('소령어제점수').setDescription('소령 어제 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령어제점수').setDescription('중령 어제 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('소령지난주점수').setDescription('소령 지난주 점수 (감독관 전용)'),
    new SlashCommandBuilder().setName('중령지난주점수').setDescription('중령 지난주 점수 (감독관 전용)'),

    // ✅ 공용(요청하신 /어제점수 /지난주점수)
    new SlashCommandBuilder().setName('어제점수').setDescription('소령/중령 어제 점수 한 번에 보기 (감독관 전용)'),
    new SlashCommandBuilder().setName('지난주점수').setDescription('소령/중령 지난주 점수 한 번에 보기 (감독관 전용)'),

    // 초기화/통계
    소령오늘초기화,
    중령오늘초기화,
    new SlashCommandBuilder().setName('초기화주간').setDescription('주간 전체 초기화 (감독관)'),
    new SlashCommandBuilder().setName('행정통계').setDescription('전체 통계 (감독관)')
  ]);

  console.log('✅ 명령어 등록 완료');
}

// ================== 이벤트 ==================
client.once('ready', async () => {
  console.log(`${client.user.tag} 준비 완료!`);
  loadData();

  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);

  // ✅ weekStart는 "일요일 시작"으로 맞춤
  if (!data.소령.weekStart) data.소령.weekStart = thisWeekStart;
  if (!data.중령.weekStart) data.중령.weekStart = thisWeekStart;
  saveData();

  await registerCommands();

  // 매일 02:00: 어제 스냅샷 저장
  cron.schedule('0 2 * * *', () => runDailyAutoReset(), { timezone: 'Asia/Seoul' });

  // ✅ 매주 일요일 02:00: 지난주 스냅샷 + weekStart 갱신
  cron.schedule('0 2 * * 0', () => runWeeklyAutoReset(), { timezone: 'Asia/Seoul' });

  console.log('⏰ 자동 스냅샷/초기화 스케줄 등록 완료 (매일 02:00 / 매주 일 02:00)');
});

client.on('interactionCreate', async interaction => {
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

  // ================== 보고서 ==================
  if (cmd === '소령행정보고' || cmd === '중령행정보고') {
    const is소령 = cmd === '소령행정보고';
    const nick = `<@${interaction.user.id}>`; // ✅ 닉네임 입력 제거: 보고자 자동 멘션
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

    u.nick = nick; // ✅ 멘션 저장
    if (!u.daily[date]) u.daily[date] = { admin: 0, extra: 0 };

    u.daily[date].admin += adminCount;
    u.daily[date].extra += extra;

    // 누적은 유지하되, 초기화/삭제 시 recomputeTotals로 정합성 맞춤
    u.totalAdmin += adminCount;
    u.totalExtra += extra;

    // ✅ 오늘/해당일 점수 캐시 무효화(정확성)
    dayTotalsCache.delete(`${is소령 ? '소령' : '중령'}|${date}`);

    saveData();

    // ✅ 사진: files로 첨부 → 갤러리 형태(세로 공간 최소화)
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

  // ================== 감독관 전용 ==================
  if (
    cmd === '소령오늘점수' || cmd === '중령오늘점수' ||
    cmd === '소령주간점수' || cmd === '중령주간점수' ||
    cmd === '소령어제점수' || cmd === '중령어제점수' ||
    cmd === '소령지난주점수' || cmd === '중령지난주점수' ||
    cmd === '어제점수' || cmd === '지난주점수' ||
    cmd === '초기화주간' || cmd === '소령오늘초기화' || cmd === '중령오늘초기화' ||
    cmd === '행정통계'
  ) {
    if (!isSupervisor()) {
      return interaction.reply({ content: '❌ 감독관만 사용할 수 있습니다.', ephemeral: true });
    }
  }

  // 오늘/주간
  if (cmd === '소령오늘점수' || cmd === '중령오늘점수') {
    const rankName = cmd === '소령오늘점수' ? '소령' : '중령';
    return interaction.reply({ embeds: [createTodayRankingEmbed(rankName)] });
  }

  if (cmd === '소령주간점수' || cmd === '중령주간점수') {
    const rankName = cmd === '소령주간점수' ? '소령' : '중령';
    return interaction.reply({ embeds: [createWeeklyRankingEmbed(rankName)] });
  }

  // ✅ 개별: 어제/지난주
  if (cmd === '소령어제점수' || cmd === '중령어제점수') {
    const rankName = cmd === '소령어제점수' ? '소령' : '중령';
    const { date, snap } = getOrMakeYesterdaySnapshot(rankName);
    return interaction.reply({ embeds: [createDailyEmbedFromSnapshot(rankName, date, snap)] });
  }

  if (cmd === '소령지난주점수' || cmd === '중령지난주점수') {
    const rankName = cmd === '소령지난주점수' ? '소령' : '중령';
    const weeklySnap = getOrMakeLastWeekSnapshot(rankName);
    return interaction.reply({ embeds: [createWeeklyEmbedFromSnapshot(rankName, weeklySnap)] });
  }

  // ✅ 공용: 어제점수(소령+중령 한 번에)
  if (cmd === '어제점수') {
    const yMaj = getOrMakeYesterdaySnapshot('소령');
    const yLt = getOrMakeYesterdaySnapshot('중령');

    const dateStr = yMaj.date;

    const embed = new EmbedBuilder()
      .setTitle(`어제 점수 (기준일: ${dateStr})`)
      .setDescription('아래 임베드 2개로 소령/중령을 각각 표시합니다.');

    return interaction.reply({
      embeds: [
        embed,
        createDailyEmbedFromSnapshot('소령', dateStr, yMaj.snap),
        createDailyEmbedFromSnapshot('중령', dateStr, yLt.snap)
      ]
    });
  }

  // ✅ 공용: 지난주점수(소령+중령 한 번에)
  if (cmd === '지난주점수') {
    const wMaj = getOrMakeLastWeekSnapshot('소령');
    const wLt = getOrMakeLastWeekSnapshot('중령');

    const embed = new EmbedBuilder()
      .setTitle('지난주 점수')
      .setDescription('아래 임베드 2개로 소령/중령을 각각 표시합니다.');

    return interaction.reply({
      embeds: [
        embed,
        createWeeklyEmbedFromSnapshot('소령', wMaj),
        createWeeklyEmbedFromSnapshot('중령', wLt)
      ]
    });
  }

  // ✅ /초기화주간:
  if (cmd === '초기화주간') {
    const majRes = clearPrev7ReportDaysBeforeThisWeek(data.소령);
    const ltRes = clearPrev7ReportDaysBeforeThisWeek(data.중령);

    // weekStart도 이번 주 일요일로 맞춤
    data.소령.weekStart = majRes.thisWeekStart;
    data.중령.weekStart = ltRes.thisWeekStart;

    pruneOldDaily(21);
    pruneOldWeekly(12);

    // ✅ 대규모 삭제 후 캐시 전체 무효화
    dayTotalsCache.clear();

    saveData();

    // 표시용: rangeEnd는 미포함이므로 -1일을 표시
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

      // ✅ 캐시 무효화
      dayTotalsCache.delete(`${is소령 ? '소령' : '중령'}|${date}`);

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

    // ✅ 캐시 무효화
    dayTotalsCache.delete(`${is소령 ? '소령' : '중령'}|${date}`);

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
  console.log('❌ TOKEN이 설정되지 않았습니다! (.env 또는 환경변수 TOKEN 확인)');
  process.exit(1);
}

client.login(TOKEN);

/*
================== 변경 적용 요약 ==================

[1] 퍼센타일 정의 개선
- 기존: ceil(rank/n*100) → 인원이 적으면 1등도 34% 등으로 표시
- 개선: getTopPercentFromRank(rank,n)로 1~100 선형 정규화
  (n=1이면 1%, n이 작아도 1등이 1%처럼 자연스럽게 보임)
- 배점 구간(10/34/66/90)은 그대로 사용 가능

[2] 주간 점수 계산 최적화
- getDayTotalsOnly(rankName,dateStr) 도입: 해당 날짜의 userId->total만 계산 + 캐시
- makeWeeklySnapshot / createWeeklyRankingEmbed에서 buildDayScores 반복 호출 제거

[3] 닉네임 입력 제거 + 자동 멘션 저장/표시
- /소령행정보고, /중령행정보고에서 닉네임 옵션 삭제
- 보고 시 nick = `<@interaction.user.id>` 로 저장/출력
*/