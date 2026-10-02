const https = require('https');
require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!BOT_TOKEN || !GEMINI_KEY) {
    console.error("Ошибка: Проверьте, заполнен ли файл .env!");
    process.exit(1);
}

// Умное локальное хранилище памяти для каждого пользователя
const userContexts = {};

function makePostRequest(url, data) {
    return new Promise((resolve, reject) => {
        const jsonData = JSON.stringify(data);
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(jsonData)
            }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(jsonData);
        req.end();
    });
}

function makeGetRequest(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

async function sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try { await makePostRequest(url, { chat_id: chatId, text: text }); } catch (e) { }
}

async function getCbrRates(dateStr) {
    try {
        const url = `https://www.cbr.ru/scripts/XML_daily.asp?date_req=${dateStr}`;
        const xmlData = await makeGetRequest(url);
        
        const usdMatch = xmlData.match(/<Valute ID="R01235">[\s\S]*?<Value>([\s\S]*?)<\/Value>/);
        const eurMatch = xmlData.match(/<Valute ID="R01239">[\s\S]*?<Value>([\s\S]*?)<\/Value>/);
        
        const usd = usdMatch ? usdMatch[1].replace(',', '.') : 'Нет данных';
        const eur = eurMatch ? eurMatch[1].replace(',', '.') : 'Нет данных';
        
        return `Данные ЦБ РФ: Доллар = ${usd} руб., Евро = ${eur} руб.`;
    } catch (e) {
        return null;
    }
}

async function askGemini(chatId, question) {
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
    
    // Инициализируем локальную текстовую память для пользователя
    if (!userContexts[chatId]) {
        userContexts[chatId] = "";
    }
    
    let currentQuestion = question;
    const lowerText = question.toLowerCase();
    
    // Проверка курсов валют
    if (lowerText.includes('курс') || lowerText.includes('евро') || lowerText.includes('доллар') || lowerText.includes('валют')) {
        const dateRegex = /(\d{2})\.(\d{2})\.(\d{4})/;
        const match = question.match(dateRegex);
        
        let targetDate = '';
        if (match) {
            targetDate = match[0];
        } else {
            const today = new Date();
            const dd = String(today.getDate()).padStart(2, '0');
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const yyyy = today.getFullYear();
            targetDate = `${dd}.${mm}.${yyyy}`;
        }
        
        const cbrInfo = await getCbrRates(targetDate);
        if (cbrInfo) {
            currentQuestion = `Пользователь спросил курс валют. Данные Центробанка: ${cbrInfo}. Красиво ответь пользователю.`;
        }
    }

    // Собираем весь контекст в один простой текст, который Google примет на 100%
    let fullPrompt = "Ты — крутой, умный и живой помощник. Отвечай емко, понятно и по делу, без лишней «воды» и долгих вступлений. Пиши в дружеском тоне, используй немного подходящих эмодзи, но сохраняй лаконичность, чтобы ответ читался легко и быстро.\n\n";
    
    if (userContexts[chatId] !== "") {
        fullPrompt += `История предыдущего диалога для памяти:\n${userContexts[chatId]}\n`;
    }
    
    fullPrompt += `Текущий вопрос пользователя: "${currentQuestion}"`;
    
    const payload = { contents: [{ parts: [{ text: fullPrompt }] }] };
    
    try {
        const result = await makePostRequest(url, payload);
        
        if (result.error) {
            console.error("Ошибка Google:", result.error.message);
            return "Извини, возникла заминка со связью. Попробуй написать мне ещё раз через пару секунд.";
        }

        if (result.candidates && result.candidates[0].content.parts[0].text) {
            const aiText = result.candidates[0].content.parts[0].text;
            
            // Записываем этот шаг в нашу локальную текстовую память
            userContexts[chatId] += `Пользователь: ${question}\nБот: ${aiText}\n`;
            
            // Отрезаем старую память, если она стала слишком длинной (держим до 1000 символов)
            if (userContexts[chatId].length > 1000) {
                userContexts[chatId] = userContexts[chatId].substring(userContexts[chatId].length - 1000);
            }
            
            return aiText;
        }
    } catch (e) {
        console.error("Сбой:", e.message);
    }
    return "Не удалось связаться с ИИ. Пожалуйста, попробуй еще раз.";
}

// Автоматический сброс старых сообщений при первом запуске
let lastUpdateId = 0;
let isFirstLaunch = true;

async function getUpdates() {
    // Если это первый запуск, просим у Telegram всего 1 последнее сообщение, чтобы узнать актуальный ID
    const limit = isFirstLaunch ? 1 : 100;
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&limit=${limit}&timeout=30`;
    
    https.get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (data.ok && data.result.length > 0) {
                    
                    if (isFirstLaunch) {
                        // Находим ID самого последнего сообщения в очереди Telegram
                        const lastUpdate = data.result[data.result.length - 1];
                        lastUpdateId = lastUpdate.update_id;
                        isFirstLaunch = false;
                        console.log("=== ОЧЕРЕДЬ ТЕЛЕГРАМ УСПЕШНО ОЧИЩЕНА ===");
                        setTimeout(getUpdates, 1000);
                        return; // Выходим, игнорируя этот старый спам
                    }

                    for (const update of data.result) {
                        lastUpdateId = update.update_id;
                        if (update.message && update.message.text) {
                            const chatId = update.message.chat.id;
                            const userText = update.message.text;

                            if (userText === '/start') {
                                userContexts[chatId] = ""; // Полный сброс памяти
                                await sendMessage(chatId, "Привет! Очередь сообщений очищена. Я готов работать с чистой локальной памятью на Gemini 3.5. Как тебя зовут?");
                            } else {
                                const aiResponse = await askGemini(chatId, userText);
                                await sendMessage(chatId, aiResponse);
                            }
                        }
                    }
                } else if (data.ok && data.result.length === 0) {
                    // Если старых сообщений не было вообще, просто переключаем режим
                    isFirstLaunch = false;
                }
            } catch (e) { }
            setTimeout(getUpdates, 1500); // Опрос раз в 1.5 секунды
        });
    }).on('error', (err) => {
        setTimeout(getUpdates, 5000);
    });
}

process.on('uncaughtException', (err) => {
    setTimeout(getUpdates, 5000);
});

console.log("=== ЗАПУСК БОТА С АВТО-ОЧИСТКОЙ ОЧЕРЕДИ ===");
getUpdates();