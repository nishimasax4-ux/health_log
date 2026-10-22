/**
 * ヘルスログ - AI中継サーバー(Cloudflare Workers版)
 * バージョン: v1.25 (index.html・sw.js・README.mdと揃えています。対応するアプリ側の
 *   バージョンより古くても、未対応のpresetは自動でnutrition設定にフォールバックする
 *   ため大きな問題にはなりませんが、再デプロイすると新機能がフルに使えます)
 *
 * 役割はこれだけです:
 *   アプリ(index.html)から届いた「食品名を教えて」「この写真は何?」という
 *   依頼を受け取り、Groq(優先)またはGemini(フォールバック)のAIに転送し、
 *   結果をアプリへ返す。それ以外は何もしません(記録の保存・同期は行いません。
 *   記録はすべて端末のブラウザ内にJSONで保存されます)。
 *
 * 【デプロイ手順】
 *   1. https://dash.cloudflare.com を開き、Workers & Pages → Create → Worker
 *   2. エディタにこのファイルの中身を全部貼り付けて「Deploy」
 *   3. Settings → Variables and Secrets で、以下の3つをシークレットとして追加:
 *        APP_TOKEN      … このWorkerを呼べる合言葉(自分で好きな文字列を決める。
 *                          英数字20文字程度を推奨。例: 32文字のランダム文字列)
 *        GROQ_API_KEY   … console.groq.com で無料発行(推奨。クレジットカード不要)
 *        GEMINI_API_KEY … Google AI Studio (aistudio.google.com) で発行(任意・保険)
 *      どちらか一方のキーだけでも動きますが、両方あると安定します。
 *   4. デプロイ後に発行されるURL(https://xxxxx.workers.dev)を、
 *      index.html の WORKER_URL に貼り付ける
 *   5. index.html の WORKER_TOKEN に、手順3で決めたAPP_TOKENと同じ文字列を貼り付ける
 *   6. index.html(sw.js も同じフォルダに置いたまま)を配布する
 *
 * 【料金について】
 *   Cloudflare Workersの無料枠は1日10万リクエストまでで、個人利用なら十分足ります。
 *   Groq・Geminiも無料枠の範囲で使う前提です(このコードは無料枠を超えるような
 *   大量リクエストはしません)。
 */

// ---- モデル設定 ----
// Gemini: 軽量モデルを優先し、失敗したら順にフォールバックする。
const GEMINI_LITE_MODELS = ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite"];
const GEMINI_MODEL = "gemini-3.7-flash";
const GEMINI_FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-2.5-flash"];
const NUTRITION_MODELS = [...GEMINI_LITE_MODELS, GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
const GEMINI_VISION_MODELS = ["gemini-2.5-flash", GEMINI_MODEL];

// Groq: テキスト・画像(Vision)それぞれのモデル。
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_VISION_MODELS = ["qwen/qwen3.6-27b", "qwen/qwen3.8-27b"];

// アプリ側(index.html)が送ってくる preset ごとのモデル・トークン上限。
const AI_PRESETS = {
  nutrition: { models: NUTRITION_MODELS, maxTokens: 512 },
  photo: { models: null, maxTokens: 700 }, // 画像判定は常にVision系モデルを使うのでmodelsは未使用
  // 有酸素・家事マスタの「🔍 AIで運動強度を調べる」用(v48)。返す値はMETひとつだけなので
  // トークン上限は小さめ。このpresetが無い古いWorkerに対しても、アプリ側がmaxTokensを
  // 明示的に送るため実害はなく、モデル選定だけnutritionと同じにフォールバックする。
  activityMet: { models: NUTRITION_MODELS, maxTokens: 200 },
};
const AI_PROMPT_MAX = 20000;
const AI_MAXTOKENS_MAX = 1500;
// 画像(base64文字列)の上限。長辺768pxのJPEGなら余裕をもって収まる大きさ(約6MB)。
const AI_IMAGE_MAX = 8 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"];

// ---- CORS ----
// 静的ページ(index.html)は file:// やGitHub Pages・ホスティング先など、
// Workerとは別オリジンから呼ばれる前提なので、素朴に全許可にしている。
//
// 【重要・APP_TOKENは「秘密」ではありません】
// APP_TOKENは配布する index.html の中に書かれるため、アプリを開いた人なら誰でも
// ブラウザの開発者ツールやソース表示で読み取れます。つまりこのトークンは
// 「誤爆や無関係な第三者からの素朴なアクセスを弾く鍵」であって、
// 「本気で調べる人に対する防御」にはなりません。URLを渡した相手は、
// 事実上あなたのAPIキーを使う権利を持つと考えてください。
// 対策(URLを不特定多数に広める場合は必須):
//   - Cloudflareダッシュボードの Security → Rate limiting rules で、
//     このWorkerのURLに対する1分あたり・1IPあたりのリクエスト数に上限を設ける
//   - 使いすぎ・不審なアクセスに気づいたら、APP_TOKENを新しい文字列に変更し、
//     index.html の WORKER_TOKEN も同じ値に直して配り直す(これで旧トークンは無効化)
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json_(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8", ...CORS_HEADERS },
  });
}

function safeEqual_(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// AI側のエラー内容から、返すHTTPステータスを決める(v1.4)。
//   429 … 無料枠・レート制限に当たった(時間をおけば回復する)
//   502 … AI側の障害・不正応答(こちらは悪くないが、相手が応答できていない)
//   500 … APIキー未設定など、こちら側の設定不備(直さない限り回復しない)
function httpStatusForAiError_(message) {
  const m = String(message || "");
  if (/HTTP 429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(m)) return 429;
  if (/APIキーも|設定されていません|API key not valid|API_KEY_INVALID/i.test(m)) return 500;
  return 502;
}

function clampMaxTokens_(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, AI_MAXTOKENS_MAX);
}

// ---- Gemini呼び出し ----
function shouldRetrySameModel_(code) {
  return code === 503 || (code >= 500 && code < 600);
}
function isFatalGeminiError_(code, body) {
  return code === 400 && /API key not valid|API_KEY_INVALID/i.test(String(body || ""));
}
function shouldTryNextModel_(code, body) {
  if (isFatalGeminiError_(code, body)) return false;
  if (code === 400) return true;
  return code === 429 || code === 404 || shouldRetrySameModel_(code);
}
function thinkingConfigFor_(model) {
  return /^gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "low" };
}
function roomyMaxTokens_(maxTokens) {
  return Math.max(1536, (maxTokens || 512) * 2);
}

async function callGeminiRaw_(url, prompt, maxTokens, thinkingConfig, wantJson, image) {
  const generationConfig = { temperature: 0.4, maxOutputTokens: maxTokens || 512 };
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (wantJson) generationConfig.responseMimeType = "application/json";
  const parts = image
    ? [{ inline_data: { mime_type: image.mimeType || "image/jpeg", data: image.data } }, { text: prompt }]
    : [{ text: prompt }];
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig }),
  });
  const code = res.status;
  const body = await res.text();
  return { code, body };
}

async function callGeminiModel_(apiKey, model, prompt, maxTokens, wantJson, image) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const thinking = image ? null : thinkingConfigFor_(model);
  const tokens = thinking ? (maxTokens || 512) : roomyMaxTokens_(maxTokens);
  let r = await callGeminiRaw_(url, prompt, tokens, thinking, wantJson, image);
  if (thinking && r.code === 400 && !isFatalGeminiError_(r.code, r.body)) {
    const retry = await callGeminiRaw_(url, prompt, roomyMaxTokens_(maxTokens), null, wantJson, image);
    if (retry.code === 200) return retry;
  }
  return r;
}

async function callGemini_(apiKey, prompt, maxTokens, models, wantJson, image) {
  const list = models && models.length ? models : (image ? GEMINI_VISION_MODELS : [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS]);
  let lastCode = 0, lastBody = "";
  for (let i = 0; i < list.length; i++) {
    const r = await callGeminiModel_(apiKey, list[i], prompt, maxTokens, wantJson, image);
    if (r.code === 200) {
      let data;
      try { data = JSON.parse(r.body); } catch (e) {
        throw new Error(`Geminiの応答を解釈できませんでした(モデル: ${list[i]})`);
      }
      const cand = data.candidates && data.candidates[0];
      if (!cand || !cand.content || !cand.content.parts) {
        const reason = cand && cand.finishReason ? cand.finishReason : "不明";
        throw new Error(`Geminiから本文が返りませんでした(finishReason: ${reason} / モデル: ${list[i]})`);
      }
      return cand.content.parts.map((p) => p.text || "").join("");
    }
    lastCode = r.code;
    lastBody = r.body;
    if (!shouldTryNextModel_(r.code, r.body)) break;
  }
  throw new Error(`Gemini APIエラー (HTTP ${lastCode}): ${lastBody.slice(0, 300)}`);
}

// ---- Groq呼び出し ----
async function callGroq_(apiKey, prompt, maxTokens, model, wantJson, image) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const content = image
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${image.mimeType || "image/jpeg"};base64,${image.data}` } },
      ]
    : prompt;
  const payload = {
    model: model || GROQ_MODEL,
    messages: [{ role: "user", content }],
    temperature: 0.4,
    max_tokens: maxTokens || 512,
  };
  if (wantJson) payload.response_format = { type: "json_object" };

  let res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  let code = res.status;
  let body = await res.text();
  if (code >= 500 && code < 600) {
    await new Promise((r) => setTimeout(r, 800));
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    code = res.status;
    body = await res.text();
  }
  if (code !== 200) throw new Error(`Groq APIエラー (HTTP ${code}): ${body.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(body); } catch (e) {
    throw new Error("Groqの応答を解釈できませんでした");
  }
  const choice = data.choices && data.choices[0];
  const text = choice && choice.message && choice.message.content;
  if (!text) throw new Error(`Groqから本文が返りませんでした(応答: ${body.slice(0, 200)})`);
  return text;
}

// ---- Groq優先・Geminiフォールバックの共通呼び出し ----
async function callAiText_(env, prompt, maxTokens, geminiModels, wantJson) {
  const groqKey = env.GROQ_API_KEY;
  const geminiKey = env.GEMINI_API_KEY;
  if (!groqKey && !geminiKey) {
    throw new Error("GROQ_API_KEYもGEMINI_API_KEYも設定されていません(Workerのシークレットにどちらか一方を設定してください)");
  }
  let groqError = null, geminiError = null;
  if (groqKey) {
    try { return await callGroq_(groqKey, prompt, maxTokens, GROQ_MODEL, wantJson); }
    catch (e) { groqError = e; }
  }
  if (geminiKey) {
    try { return await callGemini_(geminiKey, prompt, maxTokens, geminiModels, wantJson); }
    catch (e) { geminiError = e; }
  }
  if (geminiError && !groqKey) {
    throw new Error(
      `${geminiError.message || geminiError} ／ 現在GROQ_API_KEYが未設定のため、Geminiが不調だとAI機能が使えません。` +
      "console.groq.com で無料のキーを発行し(クレジットカード登録不要)、CloudflareのWorker設定でGROQ_API_KEYとして登録すると回避できます。"
    );
  }
  throw geminiError || groqError;
}

async function callAiVision_(env, prompt, maxTokens, image, wantJson) {
  const groqKey = env.GROQ_API_KEY;
  const geminiKey = env.GEMINI_API_KEY;
  if (!groqKey && !geminiKey) {
    throw new Error("GROQ_API_KEYもGEMINI_API_KEYも設定されていません(Workerのシークレットにどちらか一方を設定してください)");
  }
  let groqError = null, geminiError = null;
  if (groqKey) {
    for (let i = 0; i < GROQ_VISION_MODELS.length; i++) {
      try { return await callGroq_(groqKey, prompt, maxTokens, GROQ_VISION_MODELS[i], wantJson, image); }
      catch (e) { groqError = e; }
    }
  }
  if (geminiKey) {
    try { return await callGemini_(geminiKey, prompt, maxTokens, GEMINI_VISION_MODELS, wantJson, image); }
    catch (e) { geminiError = e; }
  }
  throw geminiError || groqError;
}

// ---- リクエストのハンドラ ----
function aiRelayPrompt_(body) {
  const prompt = body && body.prompt ? String(body.prompt) : "";
  if (!prompt.trim()) return { error: "promptがありません" };
  if (prompt.length > AI_PROMPT_MAX) return { error: `promptが長すぎます(${prompt.length}文字)` };
  return { prompt };
}

async function handleAiText_(env, body) {
  const p = aiRelayPrompt_(body);
  if (p.error) return { status: "error", message: p.error };
  const preset = AI_PRESETS[String((body && body.preset) || "nutrition")] || AI_PRESETS.nutrition;
  const wantJson = !!(body && body.json);
  const text = await callAiText_(env, p.prompt, clampMaxTokens_(body && body.maxTokens, preset.maxTokens), preset.models, wantJson);
  if (!text) return { status: "error", message: "AIから応答がありませんでした" };
  return { status: "ok", text: String(text).trim() };
}

async function handleAiVision_(env, body) {
  const p = aiRelayPrompt_(body);
  if (p.error) return { status: "error", message: p.error };
  if (!body.imageBase64) return { status: "error", message: "画像がありません" };
  const image = String(body.imageBase64);
  // アプリ側は長辺768pxまで縮小してから送るので、通常は数百KBで収まる。
  // 合言葉が漏れた場合に巨大な画像を送りつけられて無料枠を一気に使われないよう、
  // サーバ側でも上限を設けておく。
  if (image.length > AI_IMAGE_MAX) {
    return { status: "error", message: "画像が大きすぎます(送信前に縮小してください)" };
  }
  // mimeTypeは画像の種類だけを受け付ける(想定外の文字列をそのままAPIへ渡さない)。
  const mime = ALLOWED_IMAGE_MIME.includes(String(body.mimeType)) ? String(body.mimeType) : "image/jpeg";
  const wantJson = !!body.json;
  const text = await callAiVision_(
    env, p.prompt, clampMaxTokens_(body.maxTokens, 700),
    { data: image, mimeType: mime }, wantJson
  );
  if (!text) return { status: "error", message: "AIから応答がありませんでした" };
  return { status: "ok", text: String(text).trim() };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return json_({ status: "error", message: "POST only" }, 405);
    }

    let body;
    try {
      body = JSON.parse(await request.text());
    } catch (e) {
      return json_({ status: "error", message: "リクエストの形式が正しくありません" }, 400);
    }

    const expected = env.APP_TOKEN;
    if (!expected) {
      return json_({ status: "error", message: "サーバ側にAPP_TOKENが設定されていません" }, 500);
    }
    if (!body || !body.token || !safeEqual_(String(body.token), expected)) {
      return json_({ status: "error", message: "認証に失敗しました(トークンが一致しません)" }, 401);
    }

    try {
      const action = body.action || "";
      if (action === "aiText") {
        const r = await handleAiText_(env, body);
        return json_(r, r.status === "ok" ? 200 : 400);
      }
      if (action === "aiVision") {
        const r = await handleAiVision_(env, body);
        return json_(r, r.status === "ok" ? 200 : 400);
      }
      return json_({ status: "error", message: `不明なaction: ${action}` }, 400);
    } catch (err) {
      // AI側の障害は、Cloudflareのログ・監視で「異常」として見えるようHTTPステータスにも
      // 反映する(v1.4)。以前はすべて200で返していたため、障害が起きていても外形監視では
      // 正常に見えてしまっていた。
      // なおアプリ側(aiPost)は200以外でも本文のJSONを読むので、利用者に出る日本語の
      // 案内文は従来どおりです。HTTPステータスでの自動再試行もしません
      // (fetchWithRetry_は通信エラーのときだけ再試行する)。
      const message = String(err && err.message ? err.message : err);
      return json_({ status: "error", message }, httpStatusForAiError_(message));
    }
  },
};
