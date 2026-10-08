/**
 * survey-worker.js
 * -----------------
 * שלוחת סקר לימות המשיח (מודול API, type=api) + נקודת קצה לדשבורד ניהול.
 *
 * שני קבצים נשמרים בתיקיית השלוחה (ivr2), דרך ה-API הרגיל למפתחים
 * (הפקודות GetTextFile / UploadTextFile):
 *
 *   Surveyquestion.ini   - מוגדר ידנית מראש, מכיל את השאלה והאפשרויות.
 *   Surveydata.ini       - נכתב אוטומטית על ידי ה-Worker, שורה לכל מצביע:
 *                          <טלפון>,<מספר_אפשרות>,<תאריך_ISO>
 *
 * הגדרות נדרשות ב-ext.ini של השלוחה:
 *
 *   type=api
 *   api_link=https://YOUR-WORKER.workers.dev/survey
 *   api_add_0=token=YOUR_YEMOT_DEV_API_TOKEN
 *
 * (ה-token הוא טוקן ה-API הקבוע של ימות המשיח - "חומת האש" - המשמש
 *  את ה-Worker לקרוא ולכתוב את קבצי ה-ini באמצעות ה-API הרגיל למפתחים)
 */
 
const YEMOT_API_BASE = "https://www.call2all.co.il/ym/api/";
 
// ---------- עזרים כלליים ----------
 
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
 
function textResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
 
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}
 
// מנקה תווים שימות המשיח לא מאפשר בטקסט להשמעה (t-) ותווים
// שעלולים לשבש את תחביר תשובת השרת (& = )
function sanitizeText(s) {
  return (s || "")
    .replace(/[.\-&=]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
 
// פרסור קובץ ini פשוט (key=value בכל שורה) - עבור Surveyquestion.ini
function parseIni(text) {
  const obj = {};
  if (!text) return obj;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    obj[key] = val;
  }
  return obj;
}
 
// פרסור Surveydata.ini - שורה לכל מצביע: phone,choice,isoTime
function parseSurveyData(text) {
  const votes = [];
  if (!text) return votes;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 2) continue;
    votes.push({
      phone: (parts[0] || "").trim(),
      choice: (parts[1] || "").trim(),
      time: (parts[2] || "").trim(),
    });
  }
  return votes;
}
 
function buildIvrPath(apiExtension, filename) {
  let ext = apiExtension || "";
  if (!ext.startsWith("/")) ext = "/" + ext;
  return `ivr2:${ext}/${filename}`;
}
 
// שולף פרמטרים גם מ-query string וגם מגוף הבקשה (JSON או form), כדי
// לתמוך בשני מצבי השליחה של מודול ה-API (GET רגיל, או api_url_post=yes)
async function extractParams(request) {
  const url = new URL(request.url);
  const params = {};
  for (const [k, v] of url.searchParams.entries()) params[k] = v;
 
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") || "";
    try {
      if (contentType.includes("application/json")) {
        const body = await request.json();
        Object.assign(params, body);
      } else {
        const bodyText = await request.text();
        if (bodyText) {
          const bodyParams = new URLSearchParams(bodyText);
          for (const [k, v] of bodyParams.entries()) params[k] = v;
        }
      }
    } catch (e) {
      // גוף ריק / לא תקין - מתעלמים, נשארים עם מה שהיה ב-query string
    }
  }
  return params;
}
 
// ---------- קריאות ל-API הרגיל למפתחים של ימות המשיח ----------
 
async function callYemotApi(command, params) {
  const resp = await fetch(YEMOT_API_BASE + command, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return resp.json();
}
 
async function getTextFile(token, path) {
  const data = await callYemotApi("GetTextFile", { token, what: path });
  if (data && data.responseStatus === "OK") {
    return data.contents || "";
  }
  return "";
}
 
async function uploadTextFile(token, path, contents) {
  const data = await callYemotApi("UploadTextFile", {
    token,
    what: path,
    contents,
  });
  return data && data.responseStatus === "OK";
}
 
// מוצא את המספר הסידורי הבא הפנוי לקובץ תוכן (000, 001, 002...) בתיקיית
// שלוחת הסקר, לפי הקובץ הממוספר הגבוה ביותר שכבר קיים שם (GetIVR2DirStats).
// אם אין עדיין אף קובץ ממוספר - מתחילים מ-000.
async function getNextSerial(token, surveyExt) {
  let folderPath = surveyExt || "";
  if (!folderPath.startsWith("/")) folderPath = "/" + folderPath;
  const data = await callYemotApi("GetIVR2DirStats", { token, path: folderPath });
  if (data && data.responseStatus === "OK" && data.maxFile && data.maxFile.exists) {
    const name = data.maxFile.name || "";
    const match = name.match(/^(\d+)/);
    if (match) {
      const nextNum = parseInt(match[1], 10) + 1;
      return String(nextNum).padStart(3, "0");
    }
  }
  return "000";
}
 
// שומר הצבעה תוך צמצום הסיכוי להתנגשות בין שתי שיחות שמצביעות בו-זמנית:
// קוראים את הקובץ מחדש ממש רגע לפני הכתיבה (לא מסתמכים על עותק ישן מתחילת
// הבקשה) ובודקים שוב שהמצביע לא הספיק להצביע בינתיים דרך שיחה מקבילה.
// זה לא מבטל לחלוטין מרוץ תנאים (ל-API הזה אין נעילה אמיתית), אבל מצמצם
// משמעותית את חלון הזמן שבו שתי כתיבות יכולות לדרוס אחת את השנייה.
async function recordVoteSafely(token, dPath, voterKey, choice) {
  const MAX_ATTEMPTS = 3;
  let lastVotes = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const freshText = await getTextFile(token, dPath);
    const freshVotes = parseSurveyData(freshText);
    lastVotes = freshVotes;
 
    if (freshVotes.some((v) => v.phone === voterKey)) {
      // הצביע בינתיים משיחה אחרת שהתחרתה על אותו קובץ
      return { alreadyVoted: true, votes: freshVotes };
    }
 
    const newLine = `${voterKey},${choice},${new Date().toISOString()}`;
    const newText =
      (freshText && freshText.trim() ? freshText.trim() + "\n" : "") +
      newLine +
      "\n";
    const ok = await uploadTextFile(token, dPath, newText);
    if (ok) {
      freshVotes.push({ phone: voterKey, choice: String(choice) });
      return { alreadyVoted: false, votes: freshVotes };
    }
    // הכתיבה נכשלה - ייתכן שהתנגשה עם כתיבה מקבילה; מנסים שוב מההתחלה
  }
  // נכשל אחרי כמה ניסיונות - לא שומרים, מחזירים את המצב האחרון שנקרא
  return { alreadyVoted: false, votes: lastVotes, saveFailed: true };
}
 
// ---------- בניית תשובות לימות המשיח ----------
 
function idListMessage(text) {
  return `id_list_message=t-${sanitizeText(text)}`;
}
 
// תשובה כשלא התקבלה הקשה בכלל אחרי 3 השמעות - משמיעים הודעה קצרה
// ומאפשרים לברירת המחדל של ימות המשיח (בלי המשך שרשור) להחזיר שלוחה אחת אחורה
function noAnswerGoBack() {
  return idListMessage("לא התקבלה הקשה, חוזרים אחורה");
}
 
// ערך מיוחד שנשלח לשרת אם המשתמש לא הקיש כלום אחרי 3 השמעות (ראה ערכים 11-13 בהגדרת read)
const NO_ANSWER = "NOANSWER";
 
// ערך מיוחד לסיום איסוף אפשרויות תשובה בשלוחת הניהול (שדה לא חובה שהושאר ריק)
const OPTIONS_DONE = "DONE";
 
// שואל את השאלה ומבקש הקשה יחידה (1..N לפי מספר האפשרויות)
// paramName ייחודי לכל סבב (Vote_1, Vote_2...) כדי שערך "Confirm" ישן
// מסבב קודם לא יישאר דבוק לניסיון הצבעה חדש (ראה getCurrentRound)
// חוזר על השאלה 3 פעמים אם אין הקשה (ערך 11=3), ואם עדיין ריק - ממשיך הלאה
// עם הערך NO_ANSWER (ערכים 12=Ok, 13=NO_ANSWER) כדי שנוכל לזהות זאת ולחזור אחורה
function readDirective(questionText, allowedKeys, paramName) {
  const q = sanitizeText(questionText);
  // name,use_existing,max,min,wait,display,block_star,block_zero,key_replace,allowed_keys,repeat,ok_if_empty,empty_value,kb_block,confirm
  const paramDef = `${paramName},,1,1,10,NO,yes,yes,,${allowedKeys},3,Ok,${NO_ANSWER},,no`;
  return `read=t-${q}=${paramDef}`;
}
 
// משמיע את הבחירה שנקלטה ומבקש אישור/ביטול (1=אישור, 2=ביטול)
// גם כאן: 3 השמעות ואז ממשיך הלאה עם NO_ANSWER אם לא הוקש כלום
function confirmReadDirective(chosenOptionText, paramName) {
  const text = sanitizeText(
    `בחרתם ${chosenOptionText} לאישור הקישו אחד לביטול הקישו שתיים`
  );
  const paramDef = `${paramName},,1,1,10,NO,yes,yes,,12,3,Ok,${NO_ANSWER},,no`;
  return `read=t-${text}=${paramDef}`;
}
 
// מבקש הקלדת טקסט חופשי במקלדת עברית (T9). mandatory=true פירושו שדה
// חובה - אם לא הוקש כלום אחרי 3 השמעות, מקבלים NO_ANSWER (חוזרים אחורה).
// mandatory=false פירושו שדה רשות (לאיסוף אפשרויות תשובה נוסף) - השארה
// ריקה (# בלי טקסט) מתפרשת בתור OPTIONS_DONE, כלומר "סיימתי להקליד"
function textReadDirective(promptText, paramName, maxLen, mandatory) {
  const q = sanitizeText(promptText);
  const minLen = mandatory ? 1 : 0;
  const emptySentinel = mandatory ? NO_ANSWER : OPTIONS_DONE;
  // name,use_existing,max,min,wait,display,block_star,block_zero,key_replace,allowed_keys,repeat,ok_if_empty,empty_value,kb_block,confirm
  const paramDef = `${paramName},,${maxLen},${minLen},30,HebrewKeyboard,,,,,3,Ok,${emptySentinel},,no`;
  return `read=t-${q}=${paramDef}`;
}
 
// מבקש הקשת מספר (לדוגמה מספר סידורי לשלוחה) - לא הקלדת אותיות
function digitsReadDirective(promptText, paramName, minLen, maxLen) {
  const q = sanitizeText(promptText);
  const paramDef = `${paramName},,${maxLen},${minLen},10,Number,yes,no,,,3,Ok,${NO_ANSWER},,no`;
  return `read=t-${q}=${paramDef}`;
}
 
// ימות המשיח מצרף לכל בקשה את כל הנתונים שנאספו בסבבים קודמים באותה שיחה
// (Vote_1, Confirm_1, Vote_2...) ולא מנקה אותם - לכן צריך למצוא את מספר
// הסבב הנוכחי (הגבוה ביותר) ולא להסתמך על שם קבוע כמו "Vote"/"Confirm",
// אחרת ביטול (הקשת 2) גורם לכך שה-Confirm הישן "נדבק" להצבעה החדשה הבאה
function getCurrentRound(params) {
  let round = 0;
  for (const key of Object.keys(params)) {
    const m = key.match(/^Vote_(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > round) round = n;
    }
  }
  return round;
}
 
function getOptions(questionData) {
  const options = [];
  let i = 1;
  while (questionData["possibility" + i]) {
    options.push({ num: String(i), text: questionData["possibility" + i] });
    i++;
  }
  return options;
}
 
function isSurveyLocked(questionData) {
  return questionData.locked === "yes";
}
 
// בונה מחדש את תוכן Surveyquestion.ini משאלה+אפשרויות+מצב נעילה
function serializeQuestionIni(question, possibilities, locked) {
  let text = `question=${question}\n`;
  possibilities.forEach((p, i) => {
    text += `possibility${i + 1}=${p}\n`;
  });
  text += `locked=${locked ? "yes" : "no"}\n`;
  return text;
}
 
// myChoiceNum - אם ידוע מה המצביע הנוכחי בחר (הצבעה חדשה או חוזרת),
// המשפט "ההצבעה שלך היא..." יתווסף בתחילת ההודעה
function buildResultsText(questionData, votes, myChoiceNum) {
  const options = getOptions(questionData);
  const total = votes.length;
  const counts = {};
  for (const opt of options) counts[opt.num] = 0;
  for (const v of votes) {
    if (counts[v.choice] !== undefined) counts[v.choice]++;
  }
 
  const parts = [];
  if (myChoiceNum) {
    const myOpt = options.find((o) => o.num === String(myChoiceNum));
    if (myOpt) parts.push(`ההצבעה שלך היא ${myOpt.text}`);
  }
 
  parts.push("תוצאות הסקר עד כה");
  const sortedOptions = [...options].sort(
    (a, b) => (counts[b.num] || 0) - (counts[a.num] || 0)
  );
  for (const opt of sortedOptions) {
    const c = counts[opt.num] || 0;
    const pct = total > 0 ? Math.round((c / total) * 100) : 0;
    parts.push(`לאפשרות ${opt.text} הצביעו ${pct} אחוזים`);
  }
  parts.push(`מספר המצביעים עד כה הוא ${total}`);
  return parts.join(", ");
}
 
// טקסט לייצוא לקובץ TTS סטטי (s-NNN): "תוצאות הסקר לשאלה X, לאפשרות Y
// הצביעו Z אחוזים... מספר המשתתפים בסקר הוא N" - ניסוח שונה במכוון
// מ-buildResultsText כי זה קובץ תמונת-מצב קבועה, לא הודעה חיה "עד כה"
function buildExportText(questionData, votes) {
  const options = getOptions(questionData);
  const total = votes.length;
  const counts = {};
  for (const opt of options) counts[opt.num] = 0;
  for (const v of votes) {
    if (counts[v.choice] !== undefined) counts[v.choice]++;
  }
  const sortedOptions = [...options].sort(
    (a, b) => (counts[b.num] || 0) - (counts[a.num] || 0)
  );
 
  const parts = [`תוצאות הסקר לשאלה ${questionData.question}`];
  for (const opt of sortedOptions) {
    const c = counts[opt.num] || 0;
    const pct = total > 0 ? Math.round((c / total) * 100) : 0;
    parts.push(`לאפשרות ${opt.text} הצביעו ${pct} אחוזים`);
  }
  parts.push(`מספר המשתתפים בסקר הוא ${total}`);
  return sanitizeText(parts.join(", "));
}
 
// ---------- הלוגיקה הראשית של שלוחת הסקר ----------
 
async function handleSurveyRequest(request) {
  const params = await extractParams(request);
  const token = params.token;
  const apiExtension = params.ApiExtension || "";
  const phone = params.ApiPhone || "";
  const callId = params.ApiCallId || "";
  const round = getCurrentRound(params);
  const currentVote = round > 0 ? params["Vote_" + round] : undefined;
  const currentConfirm = round > 0 ? params["Confirm_" + round] : undefined;
 
  if (!token) {
    return textResponse(idListMessage("שגיאה חסר טוקן התחברות למערכת"));
  }
  if (!apiExtension) {
    return textResponse(idListMessage("שגיאה לא זוהתה שלוחה"));
  }
 
  const qPath = buildIvrPath(apiExtension, "Surveyquestion.ini");
  const dPath = buildIvrPath(apiExtension, "Surveydata.ini");
 
  const [qText, dText] = await Promise.all([
    getTextFile(token, qPath),
    getTextFile(token, dPath),
  ]);
 
  const questionData = parseIni(qText);
  if (!questionData.question || !questionData.possibility1) {
    return textResponse(
      idListMessage("שגיאה לא נמצאה שאלת סקר מוגדרת בקובץ השאלון")
    );
  }
 
  // כשהסקר נעול - כל מי שנכנס לשלוחה שומע הודעה אחת קבועה ותו לא,
  // בלי קשר אם כבר הצביע בעבר או באיזה שלב הוא נמצא
  if (isSurveyLocked(questionData)) {
    return textResponse(idListMessage("הסקר לא פעיל כעת"));
  }
 
  const votes = parseSurveyData(dText);
  // מזהה ייחודי למצביע: מספר טלפון, ואם אין (מספר חסום וכו') - לפי מזהה השיחה
  const voterKey = phone || "CALL-" + callId;
  const alreadyVoted = votes.some((v) => v.phone === voterKey);
 
  const options = getOptions(questionData);
  const allowedKeys = options.map((o) => o.num).join("");
 
  // מי שכבר הצביע בעבר, ומתחיל שיחה חדשה (round 0 - אין עדיין שום Vote_N)
  // - משמיעים לו את ההצבעה שלו ואת התוצאות, בלי לשאול שוב
  if (alreadyVoted && round === 0) {
    const existing = votes.find((v) => v.phone === voterKey);
    const myChoiceNum = existing ? existing.choice : null;
    return textResponse(
      idListMessage(buildResultsText(questionData, votes, myChoiceNum))
    );
  }
 
  // לא הוקש כלום אחרי 3 השמעות (של השאלה או של שאלת האישור) - חוזרים אחורה
  if (round > 0 && (currentVote === NO_ANSWER || currentConfirm === NO_ANSWER)) {
    return textResponse(noAnswerGoBack());
  }
 
  // שלב ג: יש גם הצבעה וגם תשובת אישור לסבב הנוכחי (Vote_N + Confirm_N)
  if (round > 0 && currentVote && currentConfirm !== undefined && currentConfirm !== "") {
    if (alreadyVoted) {
      // הספיק להצביע כבר בינתיים (למשל שיחה כפולה) - משמיעים תוצאות בלי לחזור על הבחירה
      return textResponse(idListMessage(buildResultsText(questionData, votes)));
    }
 
    if (String(currentConfirm) === "1") {
      // אושר - שומרים את ההצבעה (בבדיקה חוזרת שמצמצמת מרוץ תנאים מול
      // שיחה מקבילה) ומשמיעים רק את התוצאות הכלליות, בלי לחזור על מה
      // שהמאזין בחר (זה יישמע רק אם יתקשר שוב בעתיד)
      const result = await recordVoteSafely(token, dPath, voterKey, currentVote);
      return textResponse(idListMessage(buildResultsText(questionData, result.votes)));
    }
 
    // בוטל (הוקש 2) - לא שומרים כלום, שואלים את השאלה מחדש בסבב הבא
    // (שם משתנה חדש - Vote_{round+1} - כדי שה-Confirm הישן לא יידבק להצבעה הבאה)
    const nextRound = round + 1;
    return textResponse(
      readDirective(questionData.question, allowedKeys, `Vote_${nextRound}`)
    );
  }
 
  // שלב ב: יש הצבעה לסבב הנוכחי אבל עדיין אין אישור - מבקשים אישור
  if (round > 0 && currentVote) {
    const chosenOption = options.find((o) => o.num === String(currentVote));
    if (!chosenOption) {
      // הקשה לא תקינה (לא אמור לקרות בזכות allowed_keys, אבל ליתר ביטחון)
      return textResponse(
        readDirective(questionData.question, allowedKeys, `Vote_${round}`)
      );
    }
    return textResponse(
      confirmReadDirective(chosenOption.text, `Confirm_${round}`)
    );
  }
 
  // שלב א: כניסה ראשונה לשלוחה - שואלים את השאלה (סבב 1)
  return textResponse(readDirective(questionData.question, allowedKeys, "Vote_1"));
}
 
// ---------- נקודת קצה לדשבורד הניהול (HTML מקומי) ----------
 
async function handleAdminData(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const ext = url.searchParams.get("ext");
 
  if (!token || !ext) {
    return jsonResponse({ error: "חסר token או ext" }, 400);
  }
 
  const qPath = buildIvrPath(ext, "Surveyquestion.ini");
  const dPath = buildIvrPath(ext, "Surveydata.ini");
 
  const [qText, dText] = await Promise.all([
    getTextFile(token, qPath),
    getTextFile(token, dPath),
  ]);
 
  const questionData = parseIni(qText);
  const votes = parseSurveyData(dText);
  const options = getOptions(questionData);
  const total = votes.length;
 
  const counts = {};
  for (const opt of options) counts[opt.num] = 0;
  for (const v of votes) {
    if (counts[v.choice] !== undefined) counts[v.choice]++;
    else counts[v.choice] = (counts[v.choice] || 0) + 1;
  }
 
  const optionsWithStats = options.map((opt) => ({
    num: opt.num,
    text: opt.text,
    count: counts[opt.num] || 0,
    percent: total > 0 ? Math.round(((counts[opt.num] || 0) / total) * 100) : 0,
  }));
 
  // מיון מצביעים מהחדש לישן
  const sortedVotes = [...votes].sort((a, b) =>
    (b.time || "").localeCompare(a.time || "")
  );
 
  return jsonResponse({
    question: questionData.question || null,
    options: optionsWithStats,
    total,
    votes: sortedVotes.map((v) => ({
      phone: v.phone,
      choiceNum: v.choice,
      choiceText:
        (options.find((o) => o.num === v.choice) || {}).text || v.choice,
      time: v.time,
    })),
  });
}
 
// שמירת שאלה/אפשרויות חדשות ל-Surveyquestion.ini (מהדשבורד)
async function handleAdminSaveQuestion(request) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "יש לשלוח בקשת POST" }, 405);
  }
 
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "גוף הבקשה אינו JSON תקין" }, 400);
  }
 
  const { token, ext, question, options } = body || {};
 
  if (!token || !ext) {
    return jsonResponse({ error: "חסר token או ext" }, 400);
  }
  const cleanQuestion = (question || "").toString().trim();
  if (!cleanQuestion) {
    return jsonResponse({ error: "חסר טקסט שאלה" }, 400);
  }
  const cleanOptions = (Array.isArray(options) ? options : [])
    .map((o) => (o || "").toString().trim())
    .filter((o) => o.length > 0);
  if (cleanOptions.length === 0) {
    return jsonResponse({ error: "צריך לפחות אפשרות תשובה אחת" }, 400);
  }
  if (cleanOptions.length > 9) {
    return jsonResponse(
      { error: "ניתן להגדיר עד 9 אפשרויות תשובה (הקשה בודדת)" },
      400
    );
  }
 
  let iniText = `question=${cleanQuestion}\n`;
  cleanOptions.forEach((opt, i) => {
    iniText += `possibility${i + 1}=${opt}\n`;
  });
 
  const qPath = buildIvrPath(ext, "Surveyquestion.ini");
  const ok = await uploadTextFile(token, qPath, iniText);
  if (!ok) {
    return jsonResponse(
      { error: "השמירה נכשלה - בדקו שהטוקן תקין ותקף" },
      502
    );
  }
 
  return jsonResponse({ success: true });
}
 
// ---------- שלוחת ניהול טלפונית (type=api נפרדת, מצביעה על סקר קיים) ----------
//
// הגדרות נדרשות ב-ext.ini של שלוחת הניהול (שלוחה נפרדת מהסקר עצמו!):
//
//   type=api
//   api_link=https://YOUR-WORKER.workers.dev/manage
//   api_add_0=token=YOUR_YEMOT_DEV_API_TOKEN
//   api_add_1=surveyExt=/55        <- נתיב שלוחת הסקר שרוצים לנהל (חובה!)
//
// תפריט: 1=איפוס תוצאות, 2=עדכון שאלה+תשובות (הקלדה במקלדת עברית),
//        3=נעילה/פתיחה של ההצבעה, 4=יציאה, 5=ייצוא תוצאות לקובץ TTS סטטי
const MAX_MANAGE_OPTIONS = 9;
 
async function handleManageRequest(request) {
  const params = await extractParams(request);
  const token = params.token;
  // surveyExt חייב להגיע כפרמטר קבוע (api_add) כי שלוחת הניהול היא שלוחה
  // נפרדת מהסקר - ApiExtension כאן יצביע על תיקיית הניהול, לא על הסקר עצמו
  const surveyExt = params.surveyExt || "";
  const action = params.MgmtAction;
 
  if (!token) {
    return textResponse(idListMessage("שגיאה חסר טוקן התחברות למערכת"));
  }
  if (!surveyExt) {
    return textResponse(
      idListMessage("שגיאה לא הוגדר נתיב שלוחת הסקר לניהול (surveyExt)")
    );
  }
 
  const qPath = buildIvrPath(surveyExt, "Surveyquestion.ini");
  const dPath = buildIvrPath(surveyExt, "Surveydata.ini");
 
  // תפריט ראשי - עדיין לא נבחרה פעולה
  if (!action) {
    return textResponse(
      readDirective(
        "לניהול הסקר: לאיפוס תוצאות ההצבעה הקישו אחד לעדכון השאלה והתשובות הקישו שתיים לנעילה או פתיחה של ההצבעה הקישו שלוש לייצוא התוצאות לקובץ הקראה הקישו חמש ליציאה הקישו ארבע",
        "12345",
        "MgmtAction"
      )
    );
  }
  if (action === NO_ANSWER) {
    return textResponse(noAnswerGoBack());
  }
 
  // ----- 1: איפוס תוצאות -----
  if (String(action) === "1") {
    const confirmVal = params.ResetConfirm;
    if (confirmVal === undefined || confirmVal === "") {
      return textResponse(
        readDirective(
          "לאיפוס כל תוצאות ההצבעה הקיימות לצמיתות לאישור הקישו אחד לביטול הקישו שתיים",
          "12",
          "ResetConfirm"
        )
      );
    }
    if (confirmVal === NO_ANSWER) return textResponse(noAnswerGoBack());
    if (String(confirmVal) === "1") {
      await uploadTextFile(token, dPath, "");
      const resetMsg = "תוצאות ההצבעה אופסו בהצלחה";
      return textResponse(idListMessage(resetMsg));
    }
    const cancelMsg = "האיפוס בוטל";
    return textResponse(idListMessage(cancelMsg));
  }
 
  // ----- 2: עדכון שאלה ותשובות (הקלדה במקלדת עברית) -----
  if (String(action) === "2") {
    const q = params.Q;
 
    if (q === undefined || q === "") {
      return textResponse(
        textReadDirective(
          "הקלידו במקלדת עברית את טקסט השאלה החדשה ובסיום ההקלדה הקישו סולמית",
          "Q",
          120,
          true
        )
      );
    }
    if (q === NO_ANSWER) return textResponse(noAnswerGoBack());
 
    // אוספים אפשרויות תשובה אחת אחרי השנייה: Opt_1, Opt_2...
    const collectedOptions = [];
    let n = 1;
    while (params["Opt_" + n] !== undefined) {
      const val = params["Opt_" + n];
      if (n === 1 && val === NO_ANSWER) return textResponse(noAnswerGoBack());
      if (val === OPTIONS_DONE) break;
      collectedOptions.push(val);
      n++;
    }
 
    const nextKey = "Opt_" + n;
    const alreadyFinished = params[nextKey] !== undefined; // הגענו לכאן דרך ה-break (OPTIONS_DONE)
 
    if (!alreadyFinished && collectedOptions.length < MAX_MANAGE_OPTIONS) {
      const mandatory = collectedOptions.length === 0;
      const positionNum = collectedOptions.length + 1;
      const prompt = mandatory
        ? `הקלידו את אפשרות התשובה מספר ${positionNum} ובסיום הקישו סולמית`
        : `הקלידו את אפשרות התשובה מספר ${positionNum}, או הקישו סולמית בלי להקליד דבר כדי לסיים ולשמור`;
      return textResponse(textReadDirective(prompt, nextKey, 40, mandatory));
    }
 
    if (collectedOptions.length === 0) {
      return textResponse(idListMessage("לא הוקלדה אף אפשרות תשובה העדכון בוטל"));
    }
 
    const existingQuestionData = parseIni(await getTextFile(token, qPath));
    const newIniText = serializeQuestionIni(
      q,
      collectedOptions,
      isSurveyLocked(existingQuestionData)
    );
    await uploadTextFile(token, qPath, newIniText);
    const savedMsg = `השאלה עודכנה בהצלחה עם ${collectedOptions.length} אפשרויות תשובה`;
    return textResponse(idListMessage(savedMsg));
  }
 
  // ----- 3: נעילה/פתיחה של ההצבעה -----
  if (String(action) === "3") {
    const currentQuestionData = parseIni(await getTextFile(token, qPath));
    const locked = isSurveyLocked(currentQuestionData);
    const lockConfirm = params.LockConfirm;
 
    if (lockConfirm === undefined || lockConfirm === "") {
      const actionLabel = locked
        ? "לפתיחת הסקר מחדש להצבעות"
        : "לנעילת הסקר מפני הצבעות חדשות";
      return textResponse(
        readDirective(
          `הסקר כרגע ${locked ? "נעול" : "פתוח"} להצבעות ${actionLabel} הקישו אחד לביטול הקישו שתיים`,
          "12",
          "LockConfirm"
        )
      );
    }
    if (lockConfirm === NO_ANSWER) return textResponse(noAnswerGoBack());
 
    if (String(lockConfirm) === "1") {
      const opts = getOptions(currentQuestionData).map((o) => o.text);
      const newIniText = serializeQuestionIni(
        currentQuestionData.question || "",
        opts,
        !locked
      );
      await uploadTextFile(token, qPath, newIniText);
      const toggleMsg = locked ? "הסקר נפתח בהצלחה" : "הסקר ננעל בהצלחה";
      return textResponse(idListMessage(toggleMsg));
    }
    const lockCancelMsg = "הפעולה בוטלה";
    return textResponse(idListMessage(lockCancelMsg));
  }
 
  // ----- 5: ייצוא תוצאות לקובץ TTS סטטי, למספר סידורי אוטומטי בתיקיית שלוחת הסקר -----
  // המספר נקבע אוטומטית: 000 אם אין עדיין קבצי תוכן ממוספרים בתיקייה,
  // אחרת הקובץ הממוספר הגבוה ביותר הקיים + 1 (ראה getNextSerial)
  // או s-<נתיב מלא>/<המספר> משלוחה במיקום אחר - ראה תיעוד הערך "Speech" (s-)
  // נוסח השאלה בקובץ המיוצא מוקלד ע"י המנהל (לא בהכרח זהה לשאלת הסקר עצמה)
  if (String(action) === "5") {
    const exportQuestionText = params.ExportQuestion;
 
    if (exportQuestionText === undefined || exportQuestionText === "") {
      return textResponse(
        textReadDirective(
          "הקלידו במקלדת עברית את נוסח השאלה שיוקרא בקובץ התוצאות ובסיום ההקלדה הקישו סולמית",
          "ExportQuestion",
          120,
          true
        )
      );
    }
    if (exportQuestionText === NO_ANSWER) return textResponse(noAnswerGoBack());
 
    const dData = await getTextFile(token, dPath);
    const exportVotes = parseSurveyData(dData);
    const surveyQuestionData = parseIni(await getTextFile(token, qPath));
    const options = getOptions(surveyQuestionData);
    if (options.length === 0) {
      const noOptionsMsg = "שגיאה לא נמצאו אפשרויות תשובה בסקר לייצוא";
      return textResponse(idListMessage(noOptionsMsg));
    }
 
    const serial = await getNextSerial(token, surveyExt);
    // משתמשים בנוסח שהוקלד עבור "השאלה", אבל באפשרויות ובנתוני ההצבעה האמיתיים
    const exportText = buildExportText(
      { ...surveyQuestionData, question: exportQuestionText },
      exportVotes
    );
    const ttsPath = buildIvrPath(surveyExt, `${serial}.tts`);
    const ok = await uploadTextFile(token, ttsPath, exportText);
    const exportResultMsg = ok
      ? `התוצאות יוצאו בהצלחה לקובץ מספר ${serial}`
      : "הייצוא נכשל נסו שוב";
    return textResponse(idListMessage(exportResultMsg));
  }
 
  // ----- יציאה (4): חוזרים לתפריט השורש של ימות המשיח -----
  // הערה: אין ב-API פעולה שמנתקת שיחה באופן ישיר; go_to_folder="/" הוא
  // הכי קרוב ל"יציאה" אמיתית שאפשר לשלוט בה מכאן. שאר הודעות הסיום
  // (איפוס/נעילה/עדכון) מסתמכות על ברירת המחדל של ימות המשיח שחוזרת
  // שלב אחד אחורה - אם זה לא באמת מנתק את השיחה אצלכם, זה תלוי בהגדרת
  // ה-ext.ini של השלוחה שמעל שלוחת הניהול (מה שמוגדר שם כברירת מחדל
  // לסיום שלוחה), ולא משהו שה-Worker יכול לשלוט בו מרחוק
  if (String(action) === "4") {
    return textResponse("id_list_message=t-להתראות&go_to_folder=/");
  }
 
  // הקשה לא צפויה (לא אמור לקרות בזכות allowed_keys) - חוזרים לתפריט
  return textResponse(
    readDirective(
      "לניהול הסקר: לאיפוס תוצאות ההצבעה הקישו אחד לעדכון השאלה והתשובות הקישו שתיים לנעילה או פתיחה של ההצבעה הקישו שלוש לייצוא התוצאות לקובץ הקראה הקישו חמש ליציאה הקישו ארבע",
      "12345",
      "MgmtAction"
    )
  );
}
 
 
// ---------- Render / Node.js adapter ----------
import { createServer } from "node:http";
import { Readable } from "node:stream";

const app = {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "yemot-survey", time: new Date().toISOString() });
    }
    if (url.pathname === "/admin/data") return handleAdminData(request);
    if (url.pathname === "/admin/question") return handleAdminSaveQuestion(request);
    if (url.pathname === "/manage") return handleManageRequest(request);
    return handleSurveyRequest(request);
  },
};

const port = Number(process.env.PORT || 10000);
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) headers.set(key, value.join(", "));
      else if (value !== undefined) headers.set(key, value);
    }
    const init = { method: req.method || "GET", headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = Readable.toWeb(req);
      init.duplex = "half";
    }
    const response = await app.fetch(new Request(url, init));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (error) {
    console.error("Unhandled request error:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    } else res.end();
  }
});
server.listen(port, "0.0.0.0", () => {
  console.log(`Render server listening on 0.0.0.0:${port}`);
});
