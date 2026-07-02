'use strict';

const { schedule } = require('@netlify/functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;

const MESSAGES = [
  '💪 *Время работать, {name}!*\n\nТвои мышцы не растут сами по себе. Вставай, иди в зал. Или хотя бы сделай тренировку дома — без отмазок.',
  '🔥 *Напоминание от Макса!*\n\nПока ты сидишь, кто-то становится лучше тебя. Вперёд, {name}!',
  '⏰ *{name}, не забыл про тренировку?*\n\nЛучшая тренировка — та, что ты всё-таки сделал, даже когда не хотел. Пошли!',
  '🏋️ *Боец {name}, пора!*\n\nНет настроения — знаю. Не важно. Разогрейся 5 минут — и настроение появится само.',
  '💥 *{name}, стоп!*\n\nТы поставил цель. Ты начал. Не останавливайся сейчас. Сегодняшняя тренировка — это кирпичик в фундамент результата.',
  '😤 *Чего сидишь, {name}?*\n\nСегодня — день тренировки. Я жду отчёта после. Иди.',
  '🎯 *Фокус, {name}!*\n\nКаждый пропущенный день — это минус к прогрессу. Каждая сделанная тренировка — это плюс к результату. Математика простая.',
];

const TIPS = [
  '\n\n💡 _Совет дня: выпей стакан воды прямо сейчас. Гидратация — основа продуктивной тренировки._',
  '\n\n💡 _Совет дня: поешь за 1.5-2 часа до тренировки. Углеводы + немного белка._',
  '\n\n💡 _Совет дня: не пропускай разминку. 5-7 минут суставной гимнастики — и ты застрахован от травм._',
  '\n\n💡 _Совет дня: записывай рабочие веса. Прогрессия нагрузки — ключ к росту._',
  '\n\n💡 _Совет дня: сон 7-9 часов важнее любого спортпита. Мышцы растут во сне._',
  '',
  '',
];

function pick(arr, seed) {
  // Deterministic pick based on date seed to avoid random() restriction
  return arr[seed % arr.length];
}

async function tgSend(chatId, text) {
  await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

const reminderJob = async () => {
  // Get current Moscow time (UTC+3)
  const now = new Date();
  const moscowMs = now.getTime() + 3 * 60 * 60 * 1000;
  const moscow = new Date(moscowMs);
  const hh = moscow.getUTCHours();
  const mm = moscow.getUTCMinutes();

  // Round to 30-minute slots (matching how we store times)
  const slotMm = mm < 15 ? 0 : mm < 45 ? 30 : 0;
  const slotHh = mm >= 45 ? (hh + 1) % 24 : hh;
  const timeStr = `${String(slotHh).padStart(2, '0')}:${String(slotMm).padStart(2, '0')}`;

  console.log(`[reminders] Moscow time: ${hh}:${String(mm).padStart(2,'0')}, slot: ${timeStr}`);

  // Query users with reminder at this slot
  const snap = await db.collection('users')
    .where('profile.reminderTimes', 'array-contains', timeStr)
    .where('state.onboardingDone', '==', true)
    .get();

  if (snap.empty) {
    console.log('[reminders] No users to remind at this slot.');
    return { statusCode: 200 };
  }

  console.log(`[reminders] Sending reminders to ${snap.size} users.`);

  // Use date as seed for deterministic message selection
  const daySeed = moscow.getUTCFullYear() * 1000 + moscow.getUTCMonth() * 31 + moscow.getUTCDate();

  const tasks = [];
  snap.forEach((doc) => {
    const user = doc.data();
    const name = user.profile?.name || user.firstName || 'боец';
    const msgTemplate = pick(MESSAGES, daySeed + user.userId);
    const tip = pick(TIPS, daySeed + user.userId + 1);
    const finalMsg = msgTemplate.replace('{name}', name) + tip +
      '\n\n_Напиши мне после тренировки — дам следующий план!_';

    tasks.push(tgSend(user.userId, finalMsg));
  });

  await Promise.allSettled(tasks);
  return { statusCode: 200 };
};

// Runs every 30 minutes — matches the 30-min slot system
exports.handler = schedule('*/30 * * * *', reminderJob);
