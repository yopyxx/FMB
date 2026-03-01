const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ================== 설정 ==================
const TOKEN = process.env.TOKEN; // 배포 환경변수에 TOKEN 반드시 설정
const GUILD_ID = '1018194815286001756';

// ✅ 감독관 역할 ID(여러개)
const SUPERVISOR_ROLE_IDS = [
  '1018195904261529691',
  '1473688580613341419'
];

// ✅ 소령/중령 역할 ID
const MAJOR_ROLE_ID = '1472582859339596091';
const LTCOL_ROLE_ID = '1018447060627894322';

// ✅ 제외 역할(점수표시/강등대상 공통 제외)
const EXCLUDED_ROLE_IDS = [
  '1018195904261529691', // 감독관
  '1463433369869090962', // 사령본부
  '1473688580613341419'  // 인사행정부단장
];

// ✅ /강등대상 전용 추가 제외 역할
const DEMOTION_EXTRA_EXCLUDED_ROLE_IDS = [
  '1477394729808298167'  // 법무교육단
];

// ================== 디스코드 클라이언트 ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,       // 역할 보유자 전원 fetch/가입일 체크
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

// ================== 유틸: 안전한 JSON 로드 ==================
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
    console.warn('⚠ 메인 데이터가 손상되어 백업 파일로 로드합니다.');
    data = backup;
  } else {
    saveData();
  }

  // 호환/안전 세팅
  if (!data.소령) data.소령 = { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' };
  if (!data.중령) data.중령 = { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' };

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

  // 항상 백업 먼저
  try {
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_BACKUP_FILE);
  } catch (e) {
    console.warn('⚠ 백업 생성 실패(무시 가능):', e);
  }

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

// ================== 길드 멤버 로스터 ==================
function hasAnyRole(member, roleIds) {
  if (!member?.roles?.cache) return false;
  return member.roles.cache.some(r => roleIds.includes(r.id));
}

function getMemberNick(member) {
  return member?.displayName || member?.user?.globalName || member?.user?.username || '알수없음';
}

async function buildRosterForRole(guild, includeRoleId, excludeRoleIds) {
  if (!guild) return [];
  await guild.members.fetch(); // 캐시 동기화

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

// ================== 일일 점수 계산(로스터 기반) ==================
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

  const eligible = rows.filter(r => r.meetsMin);
  eligible.sort((a, b) => b.adminUnits - a.adminUnits);

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
      r.adminPoints = 0;
      r.extraPoints = 0;
      r.total = 0;
      r.percentile = null;
    }
  }

  const display = [...rows].sort((a, b) => b.total - a.total);
  return { rows, display, dateStr };
}

// ================== 스냅샷 ==================
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

// ================== Embed ==================
function createTodayRankingEmbed(rankName, dateStr, snapshot) {
  const top = (snapshot || []).slice(0, 28);
  const lines = top.length
    ? top.map((r, i) => {
      const minText = r.meetsMin ? '' : ' (최소업무 미달)';
      const pctText = r.percentile ? ` / 상위 ${r.percentile}%` : '';
      return `**${i + 1}위** ${r.nick} — **${r.total}점** 〔행정: ${r.adminPoints}${pctText} / 추가: ${r.extraPoints}${minText}〕`;
    }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} 오늘 점수 (최대 100점)`)
    .setDescription(`**일자**: ${dateStr}\n\n${lines}`)
    .setFooter({ text: '최소업무 미달자는 0점 + 퍼센타일 산정에서 제외' });
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
    .setDescription(lines)
    .setFooter({ text: '최소업무 미달자는 0점 + 퍼센타일 산정에서 제외' });
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
    .setFooter({ text: '주간=일~토(7일) 합산 / 일일 행정점수는 퍼센타일 기준' });
}

function createWeeklyRankingEmbed(rankName, weeklySnap) {
  const list = (weeklySnap?.list || []).slice(0, 28);
  const lines = list.length
    ? list.map((u, i) => `**${i + 1}위** ${u.nick} — **${u.weeklyTotal}점**`).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} 주간 점수`)
    .setDescription(`**주간 범위(새벽 2시 기준)**: ${weeklySnap.weekStart} ~ ${weeklySnap.weekEnd} (7일)\n\n${lines}`)
    .setFooter({ text: '주간=일~토(7일) 합산 / 일일 행정점수는 퍼센타일 기준' });
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

    pruneOldWeekly(12);
    saveData();
    console.log(`🔄 주간 초기화 완료 (weekStart=${thisWeekStart}, lastWeekStart=${lastWeekStart})`);
  } catch (e) {
    console.error('❌ runWeeklyAutoReset 오류:', e);
  }
}

// ================== 공용 조회(어제/지난주) ==================
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

  let key = group.lastWeekStart;
  if (!key) key = addDays(group.weekStart || getSundayWeekStart(getReportDate()), -7);

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
  // 닉네임 옵션은 선택
  const 소령Command = new SlashCommandBuilder()
    .setName('소령행정보고').setDescription('소령 행정 보고서 (소령 전용)')
    .addStringOption(o => o.setName('닉네임').setDescription('닉네임(미입력 시 서버 닉네임 자동)').setRequired(false))
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
    .addStringOption(o => o.setName('닉네임').setDescription('닉네임(미입력 시 서버 닉네임 자동)').setRequired(false))
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
    .setDescription('소령 오늘 기록 초기화 (감독관) - 특정 유저 또는 전체')
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 유저를 오늘 기록 초기화').setRequired(false));

  const 중령오늘초기화 = new SlashCommandBuilder()
    .setName('중령오늘초기화')
    .setDescription('중령 오늘 기록 초기화 (감독관) - 특정 유저 또는 전체')
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 유저를 오늘 기록 초기화').setRequired(false));

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

      new SlashCommandBuilder().setName('어제점수').setDescription('소령/중령 어제 점수 한 번에 보기 (감독관 전용)'),
      new SlashCommandBuilder().setName('지난주점수').setDescription('소령/중령 지난주 점수 한 번에 보기 (감독관 전용)'),

      소령오늘초기화,
      중령오늘초기화,
      new SlashCommandBuilder().setName('초기화주간').setDescription('주간 전체 초기화 (감독관)'),
      new SlashCommandBuilder().setName('행정통계').setDescription('전체 통계 (감독관)'),

      new SlashCommandBuilder().setName('강등대상').setDescription('이번 주 합산 150점 미만 강등 대상 표시 (감독관 전용)')
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

  // 길드 확보
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    console.error('❌ 서버를 찾을 수 없습니다. GUILD_ID 확인');
    return;
  }

  // weekStart 초기값
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);
  if (!data.소령.weekStart) data.소령.weekStart = thisWeekStart;
  if (!data.중령.weekStart) data.중령.weekStart = thisWeekStart;
  saveData();

  await registerCommands(guild);

  // 매일 02:00: 어제 스냅샷 저장
  cron.schedule('0 2 * * *', () => runDailyAutoReset(guild), { timezone: 'Asia/Seoul' });

  // 매주 일요일 02:00: 주간 스냅샷 + weekStart 갱신
  cron.schedule('0 2 * * 0', () => runWeeklyAutoReset(guild), { timezone: 'Asia/Seoul' });

  console.log('⏰ 자동 스냅샷/초기화 스케줄 등록 완료 (매일 02:00 / 매주 일 02:00)');
});

// ================== interactionCreate ==================
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    // DM 등 guild가 없는 상황 방어
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: '❌ 이 명령어는 서버에서만 사용할 수 있습니다.', ephemeral: true });
    }

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

      const optionNick = interaction.options.getString('닉네임');
      const autoNick = interaction.member ? getMemberNick(interaction.member) : (interaction.user?.username || '알수없음');
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

      u.nick = nick;
      if (!u.daily[date]) u.daily[date] = { admin: 0, extra: 0 };
      u.daily[date].admin += adminCount;
      u.daily[date].extra += extra;

      // totals는 재계산 대신 누적(기존 방식 유지)
      u.totalAdmin = (u.totalAdmin || 0) + adminCount;
      u.totalExtra = (u.totalExtra || 0) + extra;

      saveData();

      // 사진 첨부 처리
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

      return interaction.reply({ content: replyText, embeds, files, ephemeral: false });
    }

    // ================== 감독관 전용 ==================
    const supervisorOnlyCommands = new Set([
      '소령오늘점수', '중령오늘점수',
      '소령주간점수', '중령주간점수',
      '소령어제점수', '중령어제점수',
      '소령지난주점수', '중령지난주점수',
      '어제점수', '지난주점수',
      '초기화주간', '소령오늘초기화', '중령오늘초기화',
      '행정통계',
      '강등대상'
    ]);

    if (supervisorOnlyCommands.has(cmd) && !isSupervisor()) {
      return interaction.reply({ content: '❌ 감독관만 사용할 수 있습니다.', ephemeral: true });
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
      return interaction.reply({ embeds: [createTodayRankingEmbed(rankName, date, snap)] });
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
      return interaction.reply({ embeds: [createWeeklyRankingEmbed(rankName, weeklySnap)] });
    }

    // ================== 개별: 어제/지난주 ==================
    if (cmd === '소령어제점수' || cmd === '중령어제점수') {
      const rankName = cmd === '소령어제점수' ? '소령' : '중령';
      const { date, snap } = await getOrMakeYesterdaySnapshot(rankName, guild);
      return interaction.reply({ embeds: [createDailyEmbedFromSnapshot(rankName, date, snap)] });
    }

    if (cmd === '소령지난주점수' || cmd === '중령지난주점수') {
      const rankName = cmd === '소령지난주점수' ? '소령' : '중령';
      const weeklySnap = await getOrMakeLastWeekSnapshot(rankName, guild);
      return interaction.reply({ embeds: [createWeeklyEmbedFromSnapshot(rankName, weeklySnap)] });
    }

    // ================== 공용: 어제/지난주 ==================
    if (cmd === '어제점수') {
      const yMaj = await getOrMakeYesterdaySnapshot('소령', guild);
      const yLt = await getOrMakeYesterdaySnapshot('중령', guild);

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

    if (cmd === '지난주점수') {
      const wMaj = await getOrMakeLastWeekSnapshot('소령', guild);
      const wLt = await getOrMakeLastWeekSnapshot('중령', guild);

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

    // ================== /초기화주간 ==================
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

    // ================== 오늘 기록 초기화 ==================
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

    // ================== 행정통계(원자료) ==================
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
          `※ "점수"는 퍼센타일 환산 후 계산됩니다.`
        );

      return interaction.reply({ embeds: [embed] });
    }

    // ================== /강등대상 ==================
    if (cmd === '강등대상') {
      const today = getReportDate();
      const thisWeekStart = getSundayWeekStart(today);

      const excludeAll = [...new Set([...EXCLUDED_ROLE_IDS, ...DEMOTION_EXTRA_EXCLUDED_ROLE_IDS])];

      const majRoster = await buildRosterForRole(guild, MAJOR_ROLE_ID, excludeAll);
      const ltRoster = await buildRosterForRole(guild, LTCOL_ROLE_ID, excludeAll);

      const map = new Map();
      for (const rm of [...majRoster, ...ltRoster]) {
        if (!map.has(rm.userId)) map.set(rm.userId, rm);
      }
      const roster = Array.from(map.values());

      // 가입 7일 미만 제외
      const now = Date.now();
      const MIN_MS = 7 * 24 * 60 * 60 * 1000;

      const filtered = roster.filter(rm => {
        if (!rm.joinedAt) return true;
        return (now - rm.joinedAt.getTime()) >= MIN_MS;
      });

      const isLtSet = new Set(ltRoster.map(x => x.userId));
      const isMajSet = new Set(majRoster.map(x => x.userId));

      const groupMaj = data.소령;
      const groupLt = data.중령;

      const weekStartMaj = groupMaj.weekStart || thisWeekStart;
      const weekStartLt = groupLt.weekStart || thisWeekStart;

      const weekDatesMaj = Array.from({ length: 7 }, (_, i) => addDays(weekStartMaj, i));
      const weekDatesLt = Array.from({ length: 7 }, (_, i) => addDays(weekStartLt, i));

      const weeklyTotals = {}; // userId -> { nick, total, rankLabel }

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

      const title = `강등 대상 (이번 주 합산 150점 미만)`;
      const descHead =
        `**기준 주간(새벽 2시 기준)**: ${thisWeekStart} ~ ${addDays(thisWeekStart, 6)} (7일)\n` +
        `**제외**: 가입 7일 미만, 법무교육단/감독관/사령본부/인사행정부단장 보유자\n\n`;

      const lines = targets.length
        ? targets.slice(0, 40).map((t, i) => {
          const mention = `<@${t.userId}>`;
          return `**${i + 1}.** [${t.rankLabel}] ${t.nick} ${mention} — **${t.total}점**`;
        }).join('\n')
        : '✅ 조건에 해당하는 인원이 없습니다.';

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(descHead + lines)
        .setFooter({ text: targets.length > 40 ? '표시는 최대 40명까지입니다.' : ' ' });

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }
  } catch (e) {
    console.error('❌ interactionCreate 처리 중 오류:', e);
    // 이미 응답한 interaction이면 reply가 실패할 수 있어 safe 처리
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ 처리 중 오류가 발생했습니다. (로그 확인 필요)', ephemeral: true });
      }
    } catch (_) {}
  }
});

// ================== TOKEN 체크 ==================
if (!TOKEN) {
  console.log('❌ TOKEN이 설정되지 않았습니다! (환경변수 TOKEN 확인)');
  process.exit(1);
}

client.login(TOKEN);