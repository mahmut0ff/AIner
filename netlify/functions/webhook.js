'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// ─── Firebase init (singleton) ────────────────────────────────────────────────
if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
const FS = admin.firestore;

// ─── Gemini init ──────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Telegram helpers ─────────────────────────────────────────────────────────
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;

async function tgCall(method, data) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function send(chatId, text, extra = {}) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

async function sendAction(chatId, action = 'typing') {
  return tgCall('sendChatAction', { chat_id: chatId, action });
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
const usersCol = () => db.collection('users');
const userDoc = (uid) => usersCol().doc(String(uid));
const messagesCol = (uid) => userDoc(uid).collection('messages');

async function getUser(uid) {
  const snap = await userDoc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function createUser(uid, firstName, username) {
  const data = {
    userId: uid,
    firstName: firstName || '',
    username: username || '',
    createdAt: FS.FieldValue.serverTimestamp(),
    lastActive: FS.FieldValue.serverTimestamp(),
    messageCount: 0,
    profile: {
      name: firstName || '',
      age: null,
      weight: null,
      height: null,
      goal: null,        // mass | weight_loss | maintain | strength
      experience: null,  // beginner | intermediate | advanced
      reminderTimes: [], // ["07:30", "19:00"] - Moscow time, rounded to 30 min
    },
    state: {
      onboardingDone: false,
      step: 'welcome',      // onboarding step
      awaitingReminder: false,
      awaitingUpdate: null, // field name being updated
    },
  };
  await userDoc(uid).set(data);
  return data;
}

async function patchUser(uid, updates) {
  await userDoc(uid).update(updates);
}

async function getChatHistory(uid, limit = 18) {
  const snap = await messagesCol(uid)
    .orderBy('ts', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data()).reverse();
}

async function pushMessage(uid, role, content) {
  await messagesCol(uid).add({ role, content, ts: FS.FieldValue.serverTimestamp() });
}

// ─── Lookup tables ────────────────────────────────────────────────────────────
const GOAL_TEXT = {
  mass: '🏋️ Набор мышечной массы',
  weight_loss: '🔥 Похудение / жиросжигание',
  maintain: '⚖️ Поддержание формы',
  strength: '💪 Развитие максимальной силы',
};
const EXP_TEXT = {
  beginner: 'Новичок (до 6 мес)',
  intermediate: 'Средний (6 мес – 2 года)',
  advanced: 'Продвинутый (2+ года)',
};

function goalText(g) { return GOAL_TEXT[g] || 'не указана'; }
function expText(e) { return EXP_TEXT[e] || 'не указан'; }

// ─── Keyboards ────────────────────────────────────────────────────────────────
const kb = (...rows) => ({
  reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: true },
});
const noKb = { reply_markup: { remove_keyboard: true } };

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM = `Ты — ИИ-тренер по имени *Макс*. Ты жёсткий, харизматичный и хитрый тренер по фитнесу и здоровому образу жизни.

ХАРАКТЕР:
- Строгий и прямолинейный: не принимаешь отговорок. Если у пользователя нет причин — говоришь прямо.
- Хитрый: умеешь "раскусить" человека по его словам, понять реальную мотивацию и слабые места.
- Провокационный в меру: иногда подначиваешь или слегка троллишь для мотивации, но не грубо.
- В глубине — заботливый и искренне хочешь помочь, но не показываешь этого в открытую.
- Разговариваешь на "ты", неформально, со спортивным сленгом (без мата).

ЭКСПЕРТИЗА:
- Силовые тренировки и набор мышечной массы (УКБ): программы, сплиты, периодизация.
- Правильное питание (ПП): расчёт КБЖУ, режим, продукты, добавки.
- Жиросжигание: дефицит калорий, кардио, сохранение мышц.
- Восстановление: сон, режим дня, деload-недели.

ПРАВИЛА:
1. Каждые 8-10 сообщений органично вставляй мотивационную цитату в формате: _"Цитата" — Автор_
2. Перед выдачей программы тренировок всегда спроси о самочувствии, болях, последней тренировке.
3. Давай конкретику: упражнение + N×M (подходы×повторения) + вес % от ПМ + отдых X сек.
4. Для расчёта калорий используй формулу Маффина-Джеора × коэффициент активности.
5. Если человек жалуется или ищет отговорки — вытащи реальную причину и скорректируй план.
6. Помни детали из истории чата и ссылайся на них: "В прошлый раз ты говорил..."
7. Заканчивай конкретным заданием или вопросом — не оставляй разговор в воздухе.
8. На вопросы про питание давай конкретные граммы и КБЖУ.

ФОРМАТ:
- Пиши живо, энергично, коротко — без воды
- Для программ тренировок используй нумерацию и эмодзи
- *Жирный* для ключевых цифр и терминов
- Не перегружай: 2-3 конкретных совета лучше 10 размытых`;

// ─── AI response ──────────────────────────────────────────────────────────────
async function askAI(user, userText, history) {
  const p = user.profile;
  const bmi = p.weight && p.height
    ? (p.weight / ((p.height / 100) ** 2)).toFixed(1)
    : '—';

  const profileInfo = p.age
    ? `Имя: ${p.name}, Возраст: ${p.age} лет, Вес: ${p.weight} кг, Рост: ${p.height} см, ИМТ: ${bmi}, Цель: ${goalText(p.goal)}, Опыт: ${expText(p.experience)}, Сообщений всего: ${user.messageCount || 0}`
    : `Имя: ${p.name || user.firstName}, профиль не заполнен`;

  const dateStr = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const fullSystem = `${SYSTEM}\n\nПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ:\n${profileInfo}\n\nТекущая дата: ${dateStr}`;

  const geminiHistory = [
    { role: 'user', parts: [{ text: fullSystem }] },
    { role: 'model', parts: [{ text: 'Принято. Работаю в роли тренера Макса.' }] },
    ...history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
  ];

  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const chat = model.startChat({
    history: geminiHistory,
    generationConfig: { maxOutputTokens: 900, temperature: 0.88 },
  });

  const result = await chat.sendMessage(userText);
  return result.response.text();
}

// ─── Onboarding flow ──────────────────────────────────────────────────────────
async function handleOnboarding(user, text, chatId) {
  const uid = user.userId;
  const step = user.state?.step || 'welcome';

  switch (step) {
    case 'welcome': {
      await send(chatId,
        `💪 *Привет, боец!*\n\nЯ — Макс, твой личный ИИ-тренер.\n\nЯ не из тех тренеров, которые хлопают по плечу и говорят "всё будет хорошо само". Я тот, кто *заставит* тебя получить результат — через дисциплину, конкретные планы и жёсткий контроль.\n\nПервый шаг: *как тебя зовут?*`
      );
      await patchUser(uid, { 'state.step': 'name' });
      break;
    }

    case 'name': {
      const name = text.trim().split(/\s+/)[0];
      await patchUser(uid, { 'profile.name': name, 'state.step': 'age' });
      await send(chatId, `${name}... Хорошее имя. Буду помнить.\n\n*Сколько тебе лет?* (просто цифру)`);
      break;
    }

    case 'age': {
      const age = parseInt(text, 10);
      if (Number.isNaN(age) || age < 12 || age > 99) {
        await send(chatId, 'Введи возраст цифрой, например: *25*');
        return;
      }
      const comment = age < 20
        ? 'Молодо — отличное восстановление, можно пахать'
        : age < 35 ? 'Самый продуктивный возраст для прогресса'
        : age < 50 ? 'Опыт + дисциплина = твоё преимущество'
        : 'Зрелый подход — грамотная нагрузка важнее всего';
      await patchUser(uid, { 'profile.age': age, 'state.step': 'weight' });
      await send(chatId, `${age} лет. ${comment}.\n\n*Текущий вес?* (кг, можно с десятичными: 78.5)`, noKb);
      break;
    }

    case 'weight': {
      const w = parseFloat(text.replace(',', '.'));
      if (Number.isNaN(w) || w < 30 || w > 350) {
        await send(chatId, 'Введи вес в кг, например: *75*');
        return;
      }
      await patchUser(uid, { 'profile.weight': w, 'state.step': 'height' });
      await send(chatId, `${w} кг. Принято.\n\n*Рост?* (см, например: 178)`);
      break;
    }

    case 'height': {
      const h = parseFloat(text.replace(',', '.'));
      if (Number.isNaN(h) || h < 100 || h > 250) {
        await send(chatId, 'Введи рост в см, например: *178*');
        return;
      }
      const fresh = await getUser(uid);
      const w = fresh?.profile?.weight;
      const bmi = w ? (w / ((h / 100) ** 2)).toFixed(1) : null;
      const bmiComment = bmi
        ? (bmi < 18.5 ? 'Дефицит массы — надо работать' : bmi < 25 ? 'ИМТ в норме' : bmi < 30 ? 'Небольшой избыток — исправим' : 'Избыточный вес — есть над чем работать')
        : '';
      await patchUser(uid, { 'profile.height': h, 'state.step': 'goal' });
      await send(chatId,
        `Рост ${h} см.${bmi ? ` ИМТ: *${bmi}* — ${bmiComment}.` : ''}\n\nТеперь главное — *твоя цель:*`,
        kb(
          [{ text: '💪 Набор мышечной массы' }, { text: '🔥 Похудение' }],
          [{ text: '⚖️ Поддержание формы' }, { text: '🏆 Развитие силы' }]
        )
      );
      break;
    }

    case 'goal': {
      const t = text.toLowerCase();
      let goal = null;
      if (t.includes('набор') || t.includes('масс') || t.includes('мышц')) goal = 'mass';
      else if (t.includes('похуд') || t.includes('жир') || t.includes('сжиг')) goal = 'weight_loss';
      else if (t.includes('поддерж') || t.includes('форм')) goal = 'maintain';
      else if (t.includes('сил') || t.includes('strength') || t.includes('макс')) goal = 'strength';

      if (!goal) {
        await send(chatId, 'Выбери один из предложенных вариантов 👆');
        return;
      }
      await patchUser(uid, { 'profile.goal': goal, 'state.step': 'experience' });
      await send(chatId,
        `${goalText(goal)} — отличный выбор. Буду строить программу именно под это.\n\n*Твой реальный опыт в тренировках:*`,
        kb(
          [{ text: '🌱 Новичок — до 6 месяцев' }],
          [{ text: '💪 Средний — от 6 мес до 2 лет' }],
          [{ text: '🔥 Продвинутый — 2+ года' }]
        )
      );
      break;
    }

    case 'experience': {
      const t = text.toLowerCase();
      let exp = null;
      if (t.includes('новичок') || t.includes('нач') || t.includes('6 мес')) exp = 'beginner';
      else if (t.includes('средн') || t.includes('2 лет') || t.includes('год')) exp = 'intermediate';
      else if (t.includes('продвин') || t.includes('2+') || t.includes('опыт')) exp = 'advanced';

      if (!exp) {
        await send(chatId, 'Выбери один из вариантов 👆');
        return;
      }
      await patchUser(uid, {
        'profile.experience': exp,
        'state.onboardingDone': true,
        'state.step': 'done',
      });
      await send(chatId,
        `✅ *Отлично. Профиль заполнен.*\n\nСлушай внимательно: я буду требовательным, иногда жёстким. Но если ты будешь делать то, что я говорю — результат *гарантирован*.\n\n📋 *Команды:*\n/profile — твои данные\n/reminder — настроить ежедневное напоминание\n/update — обновить вес или цель\n/stats — твоя статистика\n/help — помощь\n\n*Как сейчас себя чувствуешь? Последний раз когда тренировался?*`,
        noKb
      );
      break;
    }

    default:
      await send(chatId, 'Нажми /start чтобы начать заново.');
  }
}

// ─── Command handlers ─────────────────────────────────────────────────────────
async function cmdProfile(user, chatId) {
  const p = user.profile;
  const bmi = p.weight && p.height
    ? (p.weight / ((p.height / 100) ** 2)).toFixed(1)
    : '—';
  await send(chatId,
    `👤 *Твой профиль:*\n\n` +
    `Имя: ${p.name || '—'}\n` +
    `Возраст: ${p.age ? `${p.age} лет` : '—'}\n` +
    `Вес: ${p.weight ? `${p.weight} кг` : '—'}\n` +
    `Рост: ${p.height ? `${p.height} см` : '—'}\n` +
    `ИМТ: ${bmi}\n` +
    `Цель: ${goalText(p.goal)}\n` +
    `Опыт: ${expText(p.experience)}\n` +
    `Напоминания: ${p.reminderTimes?.length ? p.reminderTimes.join(', ') + ' (МСК)' : 'не установлены'}\n\n` +
    `_Чтобы обновить данные — /update_`
  );
}

async function cmdStats(user, chatId) {
  const created = user.createdAt?.toDate
    ? user.createdAt.toDate().toLocaleDateString('ru-RU')
    : '—';
  await send(chatId,
    `📊 *Твоя статистика:*\n\n` +
    `Сообщений отправлено: *${user.messageCount || 0}*\n` +
    `С нами с: ${created}\n\n` +
    `_Продолжай в том же духе!_ 💪`
  );
}

async function cmdHelp(chatId) {
  await send(chatId,
    `🤖 *Тренер Макс — справка*\n\n` +
    `Просто пиши мне о своих тренировках, питании, самочувствии — и я дам конкретные рекомендации.\n\n` +
    `*Команды:*\n` +
    `/profile — твои данные\n` +
    `/update — обновить вес, цель или уровень\n` +
    `/reminder — настроить ежедневное напоминание\n` +
    `/stats — статистика переписки\n` +
    `/start — начать заново (сброс профиля)\n\n` +
    `*Что я умею:*\n` +
    `• Составлять программы тренировок под твой уровень\n` +
    `• Рассчитывать КБЖУ и планы питания\n` +
    `• Давать советы по восстановлению\n` +
    `• Мотивировать (жёстко, но справедливо) 😤`
  );
}

async function cmdReminder(uid, chatId) {
  await patchUser(uid, { 'state.awaitingReminder': true });
  await send(chatId,
    `⏰ *Настройка напоминания*\n\nОтправь время в формате *ЧЧ:ММ* (московское время).\n\nДоступные шаги: каждые 30 минут.\nПримеры: _07:00_, _07:30_, _18:00_, _19:30_\n\nКаждый день в это время я буду напоминать тебе о тренировке. Установи и не ной потом что забыл 😤`
  );
}

async function cmdUpdate(uid, chatId) {
  await send(chatId,
    `🔄 *Обновить профиль*\n\nЧто меняем?\n\n/update\_weight — вес\n/update\_goal — цель\n/update\_exp — уровень подготовки`
  );
}

// Round time to nearest 30 minutes
function roundToHalfHour(hh, mm) {
  const rounded = mm < 15 ? 0 : mm < 45 ? 30 : 0;
  const h = mm >= 45 ? (hh + 1) % 24 : hh;
  return `${String(h).padStart(2, '0')}:${String(rounded).padStart(2, '0')}`;
}

// ─── Main webhook handler ─────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'OK' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 200, body: 'OK' }; }

  const msg = body.message || body.edited_message;
  if (!msg?.text) return { statusCode: 200, body: 'OK' };

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();
  const firstName = msg.from.first_name || '';
  const username = msg.from.username || '';

  try {
    // ── /start ────────────────────────────────────────────────────────────────
    if (text === '/start') {
      await createUser(userId, firstName, username);
      const user = await getUser(userId);
      await handleOnboarding(user, text, chatId);
      return { statusCode: 200, body: 'OK' };
    }

    let user = await getUser(userId);
    if (!user) {
      user = await createUser(userId, firstName, username);
      await handleOnboarding(user, text, chatId);
      return { statusCode: 200, body: 'OK' };
    }

    // ── Static commands ───────────────────────────────────────────────────────
    if (text === '/profile') { await cmdProfile(user, chatId); return { statusCode: 200, body: 'OK' }; }
    if (text === '/stats') { await cmdStats(user, chatId); return { statusCode: 200, body: 'OK' }; }
    if (text === '/help') { await cmdHelp(chatId); return { statusCode: 200, body: 'OK' }; }
    if (text === '/reminder') { await cmdReminder(userId, chatId); return { statusCode: 200, body: 'OK' }; }
    if (text === '/update') { await cmdUpdate(userId, chatId); return { statusCode: 200, body: 'OK' }; }

    // ── Update subcommands ────────────────────────────────────────────────────
    if (text === '/update_weight') {
      await patchUser(userId, { 'state.awaitingUpdate': 'weight' });
      await send(chatId, '⚖️ Введи новый вес в кг (например: *82.5*):');
      return { statusCode: 200, body: 'OK' };
    }
    if (text === '/update_goal') {
      await patchUser(userId, { 'state.awaitingUpdate': 'goal' });
      await send(chatId, '🎯 Выбери новую цель:',
        kb(
          [{ text: '💪 Набор мышечной массы' }, { text: '🔥 Похудение' }],
          [{ text: '⚖️ Поддержание формы' }, { text: '🏆 Развитие силы' }]
        )
      );
      return { statusCode: 200, body: 'OK' };
    }
    if (text === '/update_exp') {
      await patchUser(userId, { 'state.awaitingUpdate': 'experience' });
      await send(chatId, '📈 Выбери уровень:',
        kb(
          [{ text: '🌱 Новичок — до 6 месяцев' }],
          [{ text: '💪 Средний — от 6 мес до 2 лет' }],
          [{ text: '🔥 Продвинутый — 2+ года' }]
        )
      );
      return { statusCode: 200, body: 'OK' };
    }

    // ── Awaiting reminder time ────────────────────────────────────────────────
    if (user.state?.awaitingReminder) {
      const m = text.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) {
        await send(chatId, 'Введи время в формате ЧЧ:ММ, например: *07:30*');
        return { statusCode: 200, body: 'OK' };
      }
      const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
      if (hh > 23 || mm > 59) {
        await send(chatId, 'Некорректное время. Попробуй ещё раз, например: *19:00*');
        return { statusCode: 200, body: 'OK' };
      }
      const rounded = roundToHalfHour(hh, mm);
      const existing = user.profile?.reminderTimes || [];
      if (!existing.includes(rounded)) {
        await patchUser(userId, {
          'profile.reminderTimes': FS.FieldValue.arrayUnion(rounded),
          'state.awaitingReminder': false,
        });
      } else {
        await patchUser(userId, { 'state.awaitingReminder': false });
      }
      await send(chatId,
        `✅ Напоминание на *${rounded}* (МСК) установлено!\n\nКаждый день в это время я буду стучаться. Отмазки не принимаю. 😤`,
        noKb
      );
      return { statusCode: 200, body: 'OK' };
    }

    // ── Awaiting profile update ───────────────────────────────────────────────
    if (user.state?.awaitingUpdate) {
      const field = user.state.awaitingUpdate;
      let ok = false;

      if (field === 'weight') {
        const w = parseFloat(text.replace(',', '.'));
        if (!Number.isNaN(w) && w > 20 && w < 400) {
          await patchUser(userId, { 'profile.weight': w, 'state.awaitingUpdate': null });
          await send(chatId, `✅ Вес обновлён: *${w} кг*`, noKb);
          ok = true;
        }
      } else if (field === 'goal') {
        const t = text.toLowerCase();
        let goal = null;
        if (t.includes('набор') || t.includes('масс') || t.includes('мышц')) goal = 'mass';
        else if (t.includes('похуд') || t.includes('жир')) goal = 'weight_loss';
        else if (t.includes('поддерж') || t.includes('форм')) goal = 'maintain';
        else if (t.includes('сил') || t.includes('мощ')) goal = 'strength';
        if (goal) {
          await patchUser(userId, { 'profile.goal': goal, 'state.awaitingUpdate': null });
          await send(chatId, `✅ Цель обновлена: *${goalText(goal)}*`, noKb);
          ok = true;
        }
      } else if (field === 'experience') {
        const t = text.toLowerCase();
        let exp = null;
        if (t.includes('новичок') || t.includes('нач') || t.includes('6 мес')) exp = 'beginner';
        else if (t.includes('средн') || t.includes('год')) exp = 'intermediate';
        else if (t.includes('продвин') || t.includes('2+')) exp = 'advanced';
        if (exp) {
          await patchUser(userId, { 'profile.experience': exp, 'state.awaitingUpdate': null });
          await send(chatId, `✅ Уровень обновлён: *${expText(exp)}*`, noKb);
          ok = true;
        }
      }

      if (!ok) {
        await send(chatId, 'Не понял. Выбери из предложенных вариантов или напиши /update чтобы отменить.');
      }
      return { statusCode: 200, body: 'OK' };
    }

    // ── Onboarding ────────────────────────────────────────────────────────────
    if (!user.state?.onboardingDone) {
      await handleOnboarding(user, text, chatId);
      return { statusCode: 200, body: 'OK' };
    }

    // ── Regular AI conversation ───────────────────────────────────────────────
    await sendAction(chatId, 'typing');

    const history = await getChatHistory(userId, 18);
    await pushMessage(userId, 'user', text);

    const aiReply = await askAI(user, text, history);

    await pushMessage(userId, 'assistant', aiReply);
    await patchUser(userId, {
      messageCount: FS.FieldValue.increment(1),
      lastActive: FS.FieldValue.serverTimestamp(),
    });

    await send(chatId, aiReply);

  } catch (err) {
    console.error('Webhook error:', err);
    try {
      await send(chatId, '⚠️ Что-то пошло не так. Попробуй снова через минуту.');
    } catch {}
  }

  return { statusCode: 200, body: 'OK' };
};
