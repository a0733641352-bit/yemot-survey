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
  const paramDef = `${paramName},,1,1,10,NO,yes,yes,,${allowedKeys},3,Ok,${NO_ANSWER},,no`;
  return `read=t-${q}=${paramDef}`;
}

function buildSurveyPrompt(questionData) {
  const options = getOptions(questionData);
  const parts = [
    `השאלה היא ${sanitizeText(questionData.question)}`
  ];

  // הקראה ברורה ואחידה: קודם השאלה, ולאחר מכן כל אפשרות
  // בניסוח "להצבעה לאפשרות X הקישו Y".
  for (const option of options) {
    parts.push(
      `להצבעה לאפשרות ${sanitizeText(option.text)} הקישו ${option.num}`
    );
  }

  if (options.length > 9) {
    parts.push("לאחר הקלדת מספר האפשרות הקישו סולמית לסיום");
  } else {
    parts.push("לבחירת האפשרות הקישו את המספר המתאים");
  }

  return parts.join(", ");
}
function readVoteDirective(questionData, paramName) {
  const options = getOptions(questionData);
  if (options.length <= 9) {
    return readDirective(buildSurveyPrompt(questionData), options.map((o) => o.num).join(""), paramName);
  }
  return digitsReadDirective(buildSurveyPrompt(questionData), paramName, 1, 3);
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
  const allowedKeys = options.length <= 9 ? options.map((o) => o.num).join("") : "";
 
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
      readVoteDirective(questionData, `Vote_${nextRound}`)
    );
  }
 
  // שלב ב: יש הצבעה לסבב הנוכחי אבל עדיין אין אישור - מבקשים אישור
  if (round > 0 && currentVote) {
    const chosenOption = options.find((o) => o.num === String(currentVote));
    if (!chosenOption) {
      // הקשה לא תקינה (לא אמור לקרות בזכות allowed_keys, אבל ליתר ביטחון)
      return textResponse(
        readVoteDirective(questionData, `Vote_${round}`)
      );
    }
    return textResponse(
      confirmReadDirective(chosenOption.text, `Confirm_${round}`)
    );
  }
 
  // שלב א: כניסה ראשונה לשלוחה - שואלים את השאלה (סבב 1)
  return textResponse(readVoteDirective(questionData, "Vote_1"));
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
    locked: isSurveyLocked(questionData),
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
 
  const { token, ext, question, options, locked, optionCount } = body || {};
 
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
  if (cleanOptions.length > 100) {
    return jsonResponse(
      { error: "ניתן להגדיר עד 100 אפשרויות תשובה" },
      400
    );
  }

  const currentQuestionData = parseIni(
    await getTextFile(token, buildIvrPath(ext, "Surveyquestion.ini"))
  );
  const finalLocked =
    locked === undefined
      ? isSurveyLocked(currentQuestionData)
      : (locked === true || locked === "true" || locked === "yes");

  let iniText = `question=${cleanQuestion}\n`;
  cleanOptions.forEach((opt, i) => {
    iniText += `possibility${i + 1}=${opt}\n`;
  });
  iniText += `locked=${finalLocked ? "yes" : "no"}\n`;
 
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
//        3=נעילה/פתיחה, 4=יציאה, 5=ייצוא תוצאות, 6=האזנת מנהל לרשימת המצביעים
const MAX_MANAGE_OPTIONS = 100;

function buildDetailedResultsText(questionData, votes) {
  const options = getOptions(questionData);
  const total = votes.length;
  const counts = {};
  for (const opt of options) counts[opt.num] = 0;
  for (const v of votes) {
    if (counts[v.choice] !== undefined) counts[v.choice]++;
  }
  const parts = ["תוצאות הסקר המפורטות"];
  for (const opt of options) {
    const count = counts[opt.num] || 0;
    const percent = total > 0 ? Math.round((count / total) * 100) : 0;
    parts.push("לאפשרות " + sanitizeText(opt.text) + " הצביעו " + count + " משתמשים שהם " + percent + " אחוזים");
  }
  parts.push("בסך הכל הצביעו " + total + " משתמשים");
  return parts.join(", ");
}
 
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
        "לניהול הסקר: לעדכון השאלה והתשובות הקישו אחד להשמעת תוצאות הסקר המפורטות הקישו שתיים להאזנה למספרי הטלפונים ולהצבעות הקישו שלוש לייצוא התוצאות לקובץ הקראה הקישו ארבע לנעילה או פתיחה של ההצבעה הקישו חמש לאיפוס תוצאות ההצבעה הקישו שש למחיקת הסקר והכנת סקר חדש הקישו שבע ליציאה הקישו שמונה",
        "12345678",
        "MgmtAction"
      )
    );
  }
  if (action === NO_ANSWER) {
    return textResponse(noAnswerGoBack());
  }
 
  // ----- 1: איפוס תוצאות -----
  if (String(action) === "6") {
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
 
  // ----- 2: הגדרת שאלה ותשובות -----
  if (String(action) === "1") {
    const optionCountRaw = params.OptionCount;
    if (optionCountRaw === undefined || optionCountRaw === "") {
      return textResponse(
        digitsReadDirective(
          "כמה אפשרויות תשובה יהיו בסקר הקישו מספר בין 1 ל 100 ובסיום הקישו סולמית",
          "OptionCount",
          1,
          3
        )
      );
    }
    if (optionCountRaw === NO_ANSWER) return textResponse(noAnswerGoBack());

    const optionCount = Number(optionCountRaw);
    if (!Number.isInteger(optionCount) || optionCount < 1 || optionCount > MAX_MANAGE_OPTIONS) {
      return textResponse(idListMessage("מספר אפשרויות לא תקין, יש לבחור מספר בין 1 ל 100"));
    }

    const q = params.Q;
    if (q === undefined || q === "") {
      return textResponse(
        textReadDirective(
          `הקלידו במקלדת עברית את טקסט השאלה החדשה מתוך ${optionCount} אפשרויות ובסיום ההקלדה הקישו סולמית`,
          "Q",
          160,
          true
        )
      );
    }
    if (q === NO_ANSWER) return textResponse(noAnswerGoBack());

    const collectedOptions = [];
    for (let n = 1; n <= optionCount; n++) {
      const key = "Opt_" + n;
      if (params[key] === undefined || params[key] === "") break;
      const val = params[key];
      if (val === NO_ANSWER) return textResponse(noAnswerGoBack());
      if (val === OPTIONS_DONE) {
        return textResponse(idListMessage(`חובה להקליד את כל ${optionCount} אפשרויות התשובה`));
      }
      collectedOptions.push(String(val).trim());
    }

    if (collectedOptions.length < optionCount) {
      const n = collectedOptions.length + 1;
      return textResponse(
        textReadDirective(
          `הקלידו את אפשרות התשובה מספר ${n} מתוך ${optionCount} ובסיום הקישו סולמית`,
          "Opt_" + n,
          120,
          true
        )
      );
    }

    const existingQuestionData = parseIni(await getTextFile(token, qPath));
    const newIniText = serializeQuestionIni(
      q,
      collectedOptions,
      isSurveyLocked(existingQuestionData)
    );
    const ok = await uploadTextFile(token, qPath, newIniText);
    if (!ok) return textResponse(idListMessage("שמירת הסקר נכשלה נסו שוב"));

    return textResponse(
      idListMessage(`השאלה עודכנה בהצלחה עם ${collectedOptions.length} אפשרויות תשובה`)
    );
  }

  // ----- 3: נעילה/פתיחה של ההצבעה -----
  if (String(action) === "5") {
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
 
  // ----- 3: האזנת מנהל לרשימת המצביעים -----
  if (String(action) === "3") {
    const dData = await getTextFile(token, dPath);
    const listenerVotes = parseSurveyData(dData);
    const questionData = parseIni(await getTextFile(token, qPath));
    const options = getOptions(questionData);

    if (listenerVotes.length === 0) {
      return textResponse(idListMessage("אין כרגע מצביעים בסקר"));
    }

    const navRounds = Object.keys(params)
      .map((key) => {
        const match = /^ListenerNav_(\d+)$/.exec(key);
        return match ? Number(match[1]) : 0;
      })
      .filter((n) => Number.isInteger(n) && n > 0);

    const navRound = navRounds.length ? Math.max(...navRounds) : 0;
    const lastNav = navRound > 0 ? String(params["ListenerNav_" + navRound]) : "";

    if (lastNav === "4") {
      return textResponse(idListMessage("יציאה מהאזנת המצביעים"));
    }

    // ListenerNav_1 means the first voter was already played, so the
    // next request should move to index 1 (the second voter).
    let index = navRound;
    if (index >= listenerVotes.length) {
      index = 0;
    }

    const voter = listenerVotes[index];
    const chosen = options.find((o) => o.num === String(voter.choice));
    const choiceText = chosen ? chosen.text : "אפשרות " + voter.choice;

    const prefix =
      navRound === 0
        ? "בסקר יש " + listenerVotes.length + " מספרי טלפון. "
        : "";

    const message =
      prefix +
      "מאזין שמספר הטלפון שלו הוא " +
      sanitizeText(voter.phone) +
      " ובחר את אפשרות מספר " +
      sanitizeText(voter.choice) +
      " האפשרות היא " +
      sanitizeText(choiceText);

    const nextParam = "ListenerNav_" + (navRound + 1);
    return textResponse(
      readDirective(
        message + " למעבר למספר הבא הקישו שמונה ליציאה הקישו ארבע",
        "48",
        nextParam
      )
    );
  }

  // ----- 7: הקראת תוצאות הסקר המפורטות -----
  if (String(action) === "2") {
    const resultsData = await getTextFile(token, dPath);
    const resultsVotes = parseSurveyData(resultsData);
    const resultsQuestionData = parseIni(await getTextFile(token, qPath));
    const resultsOptions = getOptions(resultsQuestionData);

    if (resultsOptions.length === 0) {
      return textResponse(idListMessage("שגיאה לא נמצאו אפשרויות תשובה בסקר"));
    }

    return textResponse(
      idListMessage(buildDetailedResultsText(resultsQuestionData, resultsVotes))
    );
  }

  // ----- 5: ייצוא תוצאות לקובץ TTS סטטי, למספר סידורי אוטומטי בתיקיית שלוחת הסקר -----
  // המספר נקבע אוטומטית: 000 אם אין עדיין קבצי תוכן ממוספרים בתיקייה,
  // אחרת הקובץ הממוספר הגבוה ביותר הקיים + 1 (ראה getNextSerial)
  // או s-<נתיב מלא>/<המספר> משלוחה במיקום אחר - ראה תיעוד הערך "Speech" (s-)
  // נוסח השאלה בקובץ המיוצא מוקלד ע"י המנהל (לא בהכרח זהה לשאלת הסקר עצמה)
  if (String(action) === "8") {
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
 
  // ----- 7: מחיקת הסקר והכנת סקר חדש -----
  if (String(action) === "7") {
    const confirmVal = params.DeleteSurveyConfirm;
    if (confirmVal === undefined || confirmVal === "") {
      return textResponse(readDirective("מחיקת הסקר הנוכחי לצורך פתיחת סקר جديد תמחק את השאלה את כל אפשרויות התשובה ואת כל ההצבעות לאישור המחיקה הקישו אחד לביטול הקישו שתיים","12","DeleteSurveyConfirm"));
    }
    if (confirmVal === NO_ANSWER) return textResponse(noAnswerGoBack());
    if (String(confirmVal) !== "1") return textResponse(idListMessage("מחיקת הסקר בוטלה"));
    const questionDeleted = await uploadTextFile(token, qPath, "");
    const dataDeleted = await uploadTextFile(token, dPath, "");
    if (!questionDeleted || !dataDeleted) return textResponse(idListMessage("מחיקת הסקר נכשלה או הושלמה חלקית נסו שוב"));
    return textResponse(idListMessage("הסקר נמחק בהצלחה כל הנתונים אופסו וכעת ניתן להגדיר סקר חדש דרך אפשרות אחת"));
  }

  // ----- יציאה (8): חוזרים לתפריט השורש של ימות המשיח -----
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
      "לניהול הסקר: לאיפוס תוצאות ההצבעה הקישו אחד לעדכון השאלה והתשובות הקישו שתיים לנעילה או פתיחה של ההצבעה הקישו שלוש ליציאה הקישו ארבע לייצוא התוצאות לקובץ הקראה הקישו חמש להאזנה למספרי הטלפונים ולהצבעות הקישו שש להשמעת תוצאות הסקר המפורטות הקישו שבע",
      "12345678",
      "MgmtAction"
    )
  );
}
 
 
// ---------- Professional dashboard + phone configuration ----------
async function handleAdminPage() {
  return new Response("<!doctype html>\n<html lang=\"he\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Survey Studio — ניהול סקרים</title>\n<style>\n:root{--bg:#07111f;--panel:#0d1a2b;--panel2:#111f33;--line:#20334d;--text:#f5f7fb;--muted:#91a4bd;--accent:#6ea8fe;--good:#35d39a;--warn:#ffc857;--danger:#ff6b7a;--shadow:0 24px 70px #0008}\n*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#17355d 0,transparent 35%),radial-gradient(circle at 90% 10%,#26385c 0,transparent 28%),var(--bg);color:var(--text);font-family:system-ui,-apple-system,\"Segoe UI\",Arial,sans-serif;min-height:100vh}\nbutton,input,textarea{font:inherit}button{cursor:pointer;border:0}.shell{max-width:1400px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:24px}.brand{display:flex;align-items:center;gap:14px}.logo{width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#7cb7ff,#755cff);display:grid;place-items:center;font-weight:900;font-size:21px;box-shadow:0 12px 35px #5b7cff55}.brand h1{font-size:22px;margin:0}.brand p{margin:3px 0 0;color:var(--muted);font-size:13px}.actions{display:flex;gap:10px;flex-wrap:wrap}.btn{padding:11px 16px;border-radius:12px;background:#172941;color:#fff;border:1px solid var(--line)}.btn.primary{background:linear-gradient(135deg,#5d9cff,#735cff);border:0}.btn.danger{background:#4a2029;border-color:#71333d}.btn.good{background:#123d31;border-color:#1c6c54}.grid{display:grid;grid-template-columns:1.35fr .65fr;gap:18px}.card{background:linear-gradient(180deg,#102039eF,#0b1728eF);border:1px solid #263b57;border-radius:20px;box-shadow:var(--shadow);padding:20px}.card h2{font-size:16px;margin:0 0 16px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.stat{padding:18px;border-radius:16px;background:#0a1626;border:1px solid var(--line)}.stat .num{font-size:30px;font-weight:800}.stat .label{color:var(--muted);font-size:12px;margin-top:5px}.field{margin-bottom:13px}.field label{display:block;color:#cbd7e8;font-size:12px;margin-bottom:7px}.field input,.field textarea{width:100%;padding:12px 13px;background:#081321;color:#fff;border:1px solid #29415f;border-radius:11px;outline:none}.field input:focus,.field textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px #6ea8fe18}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.options{display:grid;grid-template-columns:1fr 1fr;gap:10px}.option{display:flex;gap:8px;align-items:center}.badge{display:inline-flex;padding:5px 9px;border-radius:999px;font-size:11px;background:#18304b;color:#bcd8ff}.status{margin-top:10px;color:var(--muted);font-size:13px;min-height:20px}.status.ok{color:var(--good)}.status.err{color:var(--danger)}.bars{display:grid;gap:10px}.barrow{display:grid;grid-template-columns:120px 1fr 50px;align-items:center;gap:10px;font-size:12px}.track{height:11px;border-radius:20px;background:#16263b;overflow:hidden}.fill{height:100%;background:linear-gradient(90deg,#6ea8fe,#8d6bff);border-radius:20px}.tablewrap{overflow:auto;max-height:430px}.table{width:100%;border-collapse:collapse;font-size:12px}.table th,.table td{text-align:right;padding:11px;border-bottom:1px solid #1d2d43;white-space:nowrap}.table th{color:#8fa4bf;position:sticky;top:0;background:#0d1a2b}.empty{text-align:center;color:var(--muted);padding:35px}.hidden{display:none}.hero{padding:22px;border-radius:18px;background:linear-gradient(135deg,#132d4d,#111a36);border:1px solid #294766;margin-bottom:18px}.hero strong{font-size:18px}.hero p{color:var(--muted);margin:7px 0 0;font-size:13px;line-height:1.6}.code{direction:ltr;text-align:left;background:#050c15;border:1px solid #20344e;border-radius:13px;padding:14px;white-space:pre-wrap;word-break:break-word;font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:#cfe3ff}.toast{position:fixed;bottom:24px;left:24px;padding:13px 17px;border-radius:13px;background:#12253d;border:1px solid #315171;box-shadow:0 15px 40px #0008;transform:translateY(20px);opacity:0;pointer-events:none;transition:.25s;z-index:9}.toast.show{transform:none;opacity:1}.section-title{display:flex;justify-content:space-between;align-items:center;gap:10px}.lock{color:var(--warn)}@media(max-width:900px){.grid{grid-template-columns:1fr}.stats{grid-template-columns:1fr}.options,.row{grid-template-columns:1fr}.shell{padding:15px}.top{align-items:flex-start;flex-direction:column}}\n</style>\n</head>\n<body>\n<div class=\"shell\">\n<header class=\"top\">\n  <div class=\"brand\"><div class=\"logo\">S</div><div><h1>Survey Studio</h1><p>מרכז ניהול הסקרים שלך</p></div></div>\n  <div class=\"actions\"><button class=\"btn\" id=\"refresh\">↻ רענון נתונים</button><button class=\"btn\" id=\"logout\">ניקוי התחברות</button></div>\n</header>\n\n<section class=\"hero\">\n  <strong>ניהול סקר במקום אחד</strong>\n  <p>הגדרת הסקר, צפייה בתוצאות, עריכת שאלה ואפשרויות, נעילה, איפוס, והקמת שלוחת ניהול טלפונית — הכול ממסך אחד.</p>\n</section>\n\n<div class=\"grid\">\n<section>\n<div class=\"card\">\n<div class=\"section-title\"><h2>חיבור למערכת</h2><span class=\"badge\">ימות המשיח</span></div>\n<div class=\"row\">\n<div class=\"field\"><label>טוקן API</label><input id=\"token\" type=\"password\" autocomplete=\"off\" placeholder=\"הדבק כאן את הטוקן\"></div>\n<div class=\"field\"><label>שלוחת הסקר</label><input id=\"ext\" placeholder=\"/55\"></div>\n</div>\n<div class=\"actions\"><button class=\"btn primary\" id=\"connect\">התחבר וטען סקר</button></div>\n<div class=\"status\" id=\"connectStatus\"></div>\n</div>\n\n<div class=\"card\" style=\"margin-top:18px\">\n<div class=\"section-title\"><h2>סקירה</h2><span id=\"lockBadge\" class=\"badge\">לא נטען</span></div>\n<div class=\"stats\">\n<div class=\"stat\"><div class=\"num\" id=\"total\">0</div><div class=\"label\">סה״כ הצבעות</div></div>\n<div class=\"stat\"><div class=\"num\" id=\"optionsCount\">0</div><div class=\"label\">אפשרויות</div></div>\n<div class=\"stat\"><div class=\"num\" id=\"lastVote\">—</div><div class=\"label\">הצבעה אחרונה</div></div>\n</div>\n</div>\n\n<div class=\"card\" style=\"margin-top:18px\">\n<div class=\"section-title\"><h2>התפלגות תשובות</h2><span class=\"badge\">Live</span></div>\n<div id=\"bars\" class=\"bars\"><div class=\"empty\">טען סקר כדי לראות נתונים</div></div>\n</div>\n\n<div class=\"card\" style=\"margin-top:18px\">\n<div class=\"section-title\"><h2>הצבעות אחרונות</h2><button class=\"btn\" id=\"export\">ייצוא CSV</button></div>\n<div class=\"tablewrap\"><table class=\"table\"><thead><tr><th>טלפון</th><th>בחירה</th><th>זמן</th></tr></thead><tbody id=\"votes\"></tbody></table></div>\n</div>\n</section>\n\n<aside>\n<div class=\"card\">\n<h2>עריכת הסקר</h2>\n<div class=\"field\"><label>שאלת הסקר</label><textarea id=\"question\" rows=\"4\" placeholder=\"כתוב כאן את השאלה\"></textarea></div>\n<div class=\"field\"><label>אפשרויות תשובה — 1 עד 100</label><div id=\"optionInputs\" class=\"options\"></div></div>\n<button class=\"btn primary\" id=\"saveQuestion\">שמור שאלה ואפשרויות</button>\n<div class=\"status\" id=\"questionStatus\"></div>\n</div>\n\n<div class=\"card\" style=\"margin-top:18px\">\n<h2>פעולות סקר</h2>\n<div class=\"actions\">\n<button class=\"btn good\" id=\"toggleLock\">נעילה / פתיחה</button>\n<button class=\"btn danger\" id=\"reset\">איפוס תוצאות</button>\n</div>\n<div class=\"status\" id=\"actionStatus\"></div>\n</div>\n\n<div class=\"card\" style=\"margin-top:18px\">\n<h2>שלוחת ניהול טלפונית</h2>\n<div class=\"field\"><label>שלוחת ניהול</label><input id=\"manageExt\" placeholder=\"/56\"></div>\n<div class=\"field\"><label>לינק API</label><input id=\"apiLink\" readonly></div>\n<button class=\"btn primary\" id=\"applyPhone\">הגדר את השלוחות אוטומטית</button>\n<div class=\"status\" id=\"phoneStatus\"></div>\n<p style=\"font-size:11px;color:#7f93ad;line-height:1.6\">הפעולה יוצרת ext.ini לסקר ולשלוחת הניהול ומעלה אותם ישירות למערכת לפי הטוקן שהזנת.</p>\n</div>\n\n<div class=\"card\" style=\"margin-top:18px\">\n<h2>הגדרת שלוחת הניהול</h2>\n<div id=\"configCode\" class=\"code\">טען את המערכת כדי ליצור הגדרה.</div>\n</div>\n</aside>\n</div>\n</div>\n<div id=\"toast\" class=\"toast\"></div>\n<script>\nconst $=id=>document.getElementById(id);\nlet state=null;\nconst base=location.origin;\n$(\"apiLink\").value=base+\"/manage\";\nconst saved=JSON.parse(sessionStorage.getItem(\"surveyStudio\")||\"{}\");\nif(saved.token) $(\"token\").value=saved.token;\nif(saved.ext) $(\"ext\").value=saved.ext;\nif(saved.manageExt) $(\"manageExt\").value=saved.manageExt;\n\nfunction toast(s){$(\"toast\").textContent=s;$(\"toast\").classList.add(\"show\");setTimeout(()=>$(\"toast\").classList.remove(\"show\"),2600)}\nfunction status(id,s,ok=false){$(id).textContent=s;$(id).className=\"status \"+(ok?\"ok\":\"err\")}\nfunction esc(s){return String(s??\"\").replace(/[&<>\"']/g,c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]))}\nfunction auth(){return {token:$(\"token\").value.trim(),ext:$(\"ext\").value.trim()}}\nasync function load(){\n const {token,ext}=auth(); if(!token||!ext)return;\n sessionStorage.setItem(\"surveyStudio\",JSON.stringify({token,ext,manageExt:$(\"manageExt\").value.trim()}));\n status(\"connectStatus\",\"טוען...\",true);\n try{\n  const r=await fetch(base+\"/admin/data?token=\"+encodeURIComponent(token)+\"&ext=\"+encodeURIComponent(ext));\n  const d=await r.json(); if(!r.ok||d.error)throw new Error(d.error||\"שגיאה\");\n  state=d; render(d); status(\"connectStatus\",\"החיבור הצליח\",true); toast(\"הסקר נטען בהצלחה\");\n }catch(e){status(\"connectStatus\",e.message||\"החיבור נכשל\")}\n}\nfunction render(d){\n $(\"total\").textContent=d.total||0;$(\"optionsCount\").textContent=(d.options||[]).length;\n $(\"lastVote\").textContent=d.votes?.[0]?.time?new Date(d.votes[0].time).toLocaleTimeString(\"he-IL\",{hour:\"2-digit\",minute:\"2-digit\"}):\"—\";\n $(\"question\").value=d.question||\"\";\n $(\"lockBadge\").textContent=d.locked?\"נעול\":\"פעיל\";\n $(\"lockBadge\").className=\"badge \"+(d.locked?\"lock\":\"\");\n $(\"optionInputs\").innerHTML=\"\";\n for(let i=1;i<=(d.options||[]).length;i++){const o=(d.options||[]).find(x=>String(x.num)===String(i));const div=document.createElement(\"div\");div.className=\"option\";div.innerHTML='<span class=\"badge\">'+i+'</span><input data-opt=\"'+i+'\" value=\"'+esc(o?.text||\"\")+'\" placeholder=\"אפשרות '+i+'\">';$(\"optionInputs\").appendChild(div)}\n const bars=$(\"bars\");bars.innerHTML=\"\";\n (d.options||[]).forEach(o=>{const row=document.createElement(\"div\");row.className=\"barrow\";row.innerHTML='<span>'+esc(o.text)+'</span><div class=\"track\"><div class=\"fill\" style=\"width:'+o.percent+'%\"></div></div><b>'+o.percent+'%</b>';bars.appendChild(row)});\n const tbody=$(\"votes\");tbody.innerHTML=\"\";\n (d.votes||[]).slice(0,100).forEach(v=>{const tr=document.createElement(\"tr\");tr.innerHTML='<td>'+esc(v.phone)+'</td><td>'+esc(v.choiceText)+'</td><td>'+esc(new Date(v.time).toLocaleString(\"he-IL\"))+'</td>';tbody.appendChild(tr)});\n if(!tbody.children.length)tbody.innerHTML='<tr><td colspan=\"3\" class=\"empty\">עדיין אין הצבעות</td></tr>';\n}\n$(\"connect\").onclick=load;$(\"refresh\").onclick=load;\n$(\"logout\").onclick=()=>{sessionStorage.removeItem(\"surveyStudio\");$(\"token\").value=\"\";$(\"ext\").value=\"\";state=null;toast(\"פרטי החיבור נוקו\")};\n$(\"saveQuestion\").onclick=async()=>{\n const {token,ext}=auth();if(!token||!ext)return status(\"questionStatus\",\"חסר טוקן או שלוחה\");\n const options=[...document.querySelectorAll(\"[data-opt]\")].map(x=>x.value.trim()).filter(Boolean);\n try{const r=await fetch(base+\"/admin/question\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({token,ext,question:$(\"question\").value.trim(),options})});const d=await r.json();if(!r.ok||d.error)throw new Error(d.error||\"שגיאה\");status(\"questionStatus\",\"הסקר נשמר בהצלחה\",true);toast(\"השאלה עודכנה\");load()}catch(e){status(\"questionStatus\",e.message)}\n};\n$(\"toggleLock\").onclick=async()=>{\n const {token,ext}=auth();if(!state)return;\n if(!confirm(state.locked?\"לפתוח את הסקר?\":\"לנעול את הסקר?\"))return;\n const opts=(state.options||[]).map(x=>x.text);try{const r=await fetch(base+\"/admin/question\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({token,ext,question:state.question,options:opts,locked:!state.locked})});const d=await r.json();if(!r.ok||d.error)throw new Error(d.error||\"שגיאה\");status(\"actionStatus\",state.locked?\"הסקר נפתח\":\"הסקר ננעל\",true);load()}catch(e){status(\"actionStatus\",e.message)}\n};\n$(\"reset\").onclick=async()=>{\n const {token,ext}=auth();if(!confirm(\"לאפס את כל ההצבעות? הפעולה אינה ניתנת לביטול.\"))return;\n try{const r=await fetch(base+\"/admin/reset\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({token,ext})});const d=await r.json();if(!r.ok||d.error)throw new Error(d.error||\"שגיאה\");status(\"actionStatus\",\"התוצאות אופסו\",true);load()}catch(e){status(\"actionStatus\",e.message)}\n};\n$(\"applyPhone\").onclick=async()=>{\n const {token,ext}=auth(),manageExt=$(\"manageExt\").value.trim();if(!token||!ext||!manageExt)return status(\"phoneStatus\",\"יש למלא טוקן, שלוחת סקר ושלוחת ניהול\");\n try{const r=await fetch(base+\"/api/config/apply\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({token,surveyExt:ext,manageExt})});const d=await r.json();if(!r.ok||d.error)throw new Error(d.error||\"שגיאה\");$(\"configCode\").textContent=d.manageConfig;status(\"phoneStatus\",\"השלוחות הוגדרו בהצלחה\",true);toast(\"הגדרת הטלפון הושלמה\")}catch(e){status(\"phoneStatus\",e.message)}\n};\n$(\"export\").onclick=()=>{if(!state)return;const rows=[[\"מספר טלפון\",\"בחירה\",\"זמן\"],...(state.votes||[]).map(v=>[v.phone,v.choiceText,v.time])];const csv=\"\\ufeff\"+rows.map(r=>r.map(x=>'\"'+String(x??\"\").replace(/\"/g,'\"\"')+'\"').join(\",\")).join(\"\\\\n\");const a=document.createElement(\"a\");a.href=URL.createObjectURL(new Blob([csv],{type:\"text/csv;charset=utf-8\"}));a.download=\"survey-results.csv\";a.click();URL.revokeObjectURL(a.href)};\n</script>\n</body></html>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
  });
}

async function handleAdminReset(request) {
  if (request.method !== "POST") return jsonResponse({ error: "יש לשלוח POST" }, 405);
  let body; try { body = await request.json(); } catch { return jsonResponse({ error: "JSON לא תקין" }, 400); }
  const { token, ext } = body || {};
  if (!token || !ext) return jsonResponse({ error: "חסר token או ext" }, 400);
  const ok = await uploadTextFile(token, buildIvrPath(ext, "Surveydata.ini"), "");
  return ok ? jsonResponse({ success: true }) : jsonResponse({ error: "איפוס נכשל" }, 502);
}

async function handleConfigApply(request) {
  if (request.method !== "POST") return jsonResponse({ error: "יש לשלוח POST" }, 405);
  let body; try { body = await request.json(); } catch { return jsonResponse({ error: "JSON לא תקין" }, 400); }
  const { token, surveyExt, manageExt } = body || {};
  if (!token || !surveyExt || !manageExt) return jsonResponse({ error: "חסר token, surveyExt או manageExt" }, 400);
  const cleanSurvey = surveyExt.startsWith("/") ? surveyExt : "/" + surveyExt;
  const cleanManage = manageExt.startsWith("/") ? manageExt : "/" + manageExt;
  const origin = new URL(request.url).origin;
  const surveyConfig = [
    "type=api",
    "api_link=" + origin + "/survey",
    "api_add_0=token=" + token,
    "api_hangup_send=no"
  ].join("\n") + "\n";
  const manageConfig = [
    "type=api",
    "api_link=" + origin + "/manage",
    "api_add_0=token=" + token,
    "api_add_1=surveyExt=" + cleanSurvey,
    "api_hangup_send=no"
  ].join("\n") + "\n";
  const a = await uploadTextFile(token, buildIvrPath(cleanSurvey, "ext.ini"), surveyConfig);
  const b = await uploadTextFile(token, buildIvrPath(cleanManage, "ext.ini"), manageConfig);
  if (!a || !b) return jsonResponse({ error: "העלאת ההגדרות נכשלה. בדוק טוקן והרשאות API.", surveyUploaded:a, manageUploaded:b }, 502);
  return jsonResponse({ success:true, surveyConfig, manageConfig, surveyExt:cleanSurvey, manageExt:cleanManage });
}

// ---------- Render / Node.js adapter ----------
import { createServer } from "node:http";
import { Readable } from "node:stream";

const app = {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    const url = new URL(request.url);
    if (url.pathname === "/health") return jsonResponse({ ok:true, service:"yemot-survey", time:new Date().toISOString() });
    if (url.pathname === "/admin") return handleAdminPage();
    if (url.pathname === "/admin/data") return handleAdminData(request);
    if (url.pathname === "/admin/question") return handleAdminSaveQuestion(request);
    if (url.pathname === "/admin/reset") return handleAdminReset(request);
    if (url.pathname === "/api/config/apply") return handleConfigApply(request);
    if (url.pathname === "/manage") return handleManageRequest(request);
    return handleSurveyRequest(request);
  },
};

const port = Number(process.env.PORT || 10000);
const server = createServer(async (req,res)=>{
  try{
    const host=req.headers.host||"localhost";
    const url=new URL(req.url||"/", `http://${host}`);
    const headers=new Headers();
    for(const [k,v] of Object.entries(req.headers)){ if(Array.isArray(v)) headers.set(k,v.join(", ")); else if(v!==undefined) headers.set(k,v); }
    const init={method:req.method||"GET",headers};
    if(req.method!=="GET"&&req.method!=="HEAD"){init.body=Readable.toWeb(req);init.duplex="half";}
    const response=await app.fetch(new Request(url,init));
    res.statusCode=response.status;
    response.headers.forEach((v,k)=>res.setHeader(k,v));
    if(response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
  }catch(error){console.error("Unhandled request error:",error);if(!res.headersSent){res.statusCode=500;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end("Internal Server Error")}else res.end();}
});
server.listen(port,"0.0.0.0",()=>console.log(`Render server listening on 0.0.0.0:${port}`));