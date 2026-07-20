/**
 * =============================================================================
 * COST SIMULATION ENGINE – V.I.A. AGENT (GEMINI INTEGRATION)
 * Repository: cost-simulation-engine
 * Architecture: Generative AI FP&A Assistant with UI-RAG & Multi-Turn Memory
 * Description: Injects real-time dashboard state into Gemini 1.5 Flash to
 *              deliver contextual, executive-ready financial insights.
 *              Implements native system instructions, secure property vaults,
 *              and exponential backoff retry mechanisms.
 * Runtime: Google Apps Script (V8 Engine)
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// 1. CONSTANTS & SYSTEM PROMPTS
// ---------------------------------------------------------------------------

const VIA_CONFIG = {
  MODEL: 'gemini-1.5-flash',
  API_VERSION: 'v1beta',
  MAX_RETRIES: 3,
  INITIAL_BACKOFF_MS: 1000,
  TEMPERATURE: 0.3,          // Optimized for factual, analytical precision
  MAX_OUTPUT_TOKENS: 1024
};

const VIA_SYSTEM_INSTRUCTION = `
You are V.I.A. (Vetor Intelligence Assistant), an expert FP&A and CFO-level AI advisor.
You are embedded inside an enterprise cost simulation engine for a franchise network of 4,400+ points of sale.

CORE OPERATIONAL RULES:
1. Grounding & UI-RAG: Always base your analysis on the provided "Current UI State" and financial context. 
2. No Hallucinations: If a requested calculation or metric (e.g., inflation rates, localized tax laws) is missing from the context, explicitly state what additional data is needed instead of guessing.
3. Executive Tone: Be concise, analytical, and structured. Use bullet points and precise financial terminology (GMV, EBITDA Margin, CAGR, YoY, Basis Points/p.p., Unit Economics).
4. Proactive Guidance: When answering, conclude with a logical, strategic follow-up question or suggest a specific simulation step within the tool to deepen the analysis.
`.trim();

const FEW_SHOT_EXAMPLES = [
  {
    role: "user",
    parts: [{ text: "What is the current EBITDA margin?" }]
  },
  {
    role: "model",
    parts: [{ text: "Based on the active dashboard view, the consolidated EBITDA margin is 18.3%. This represents a +2.1 p.p. expansion over the previous fiscal year, primarily driven by optimization in variable logistics costs." }]
  },
  {
    role: "user",
    parts: [{ text: "Show me the top 3 states by revenue and their share." }]
  },
  {
    role: "model",
    parts: [{ text: "The top 3 revenue-generating regions by GMV are:\n1. **São Paulo (SP):** R$ 2.1B (38% of total network)\n2. **Rio de Janeiro (RJ):** R$ 890M (16% share)\n3. **Minas Gerais (MG):** R$ 760M (14% share)\n\nSão Paulo represents the primary concentration of network volume. Would you like to evaluate the unit economics or OPEX breakdown specifically for SP?" }]
  }
];

// ---------------------------------------------------------------------------
// 2. PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Executes a conversational query against Gemini 1.5 Flash using UI-RAG context.
 * Implements Graceful Degradation (Demo Mode) for public repository showcase.
 *
 * @param {string} question - The user's prompt or analytical question.
 * @param {Object} context - Current UI state { tab, filters, selected_pos, scenario_id, year, visible_kpis }.
 * @param {Array<Object>} [history=[]] - Previous chat messages [{role: 'user'|'model', text: '...'}]
 * @param {string} [userEmail='ANONYMOUS'] - User session identifier for audit logs.
 * @returns {string} The structured, analytical response from V.I.A.
 */
function ask(question, context, history = [], userEmail = 'ANONYMOUS') {
  const startTime = Date.now();

  try {
    if (!question || typeof question !== 'string') {
      throw new Error('Invalid query payload: Question must be a non-empty string.');
    }

    // 1. Secure Vault Lookup with Graceful Fallback for Public Portfolio
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    
    // If no key is configured, degrade gracefully to Demo Mode to preserve UX
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY' || apiKey === 'DEMO_KEY') {
      console.warn(`[VIA_Agent] No valid GEMINI_API_KEY found. Activating UI-RAG Demo Mode for user [${userEmail}].`);
      
      logTelemetryEvent_('VIA_AGENT_DEMO_QUERY', { user: userEmail, scenario: context.scenario_id });
      return generateDemoResponse_(question, context);
    }

    // 2. Format UI RAG Prompt and build API Payload (Standard Live Flow)
    const ragContextText = buildUIContextString_(context);
    const payload = buildGeminiPayload_(question, ragContextText, history);

    // 3. Execute HTTP request with resilience (Exponential Backoff)
    const responseText = executeGeminiRequestWithRetry_(payload, apiKey);

    // 4. Log successful telemetry
    logTelemetryEvent_('VIA_AGENT_QUERY', {
      user: userEmail,
      scenario: context.scenario_id || 'Base',
      questionTokensEst: Math.round(question.length / 4),
      durationMs: Date.now() - startTime
    });

    return responseText;

  } catch (err) {
    console.error(`[VIA_Agent] Fatal Exception for user [${userEmail}]: ${err.message}`, err.stack);

    logTelemetryError_('VIA_AGENT_FAILURE', err.message, {
      user: userEmail,
      questionSnippet: question ? question.substring(0, 80) : 'N/A'
    });

    return "⚠️ **System Notice:** I encountered a temporary processing delay or data sync issue while analyzing your request. Please try again in a few moments, or check your active filters.";
  }
}

/**
 * Generates a realistic, context-aware FP&A response when running in a public
 * showcase environment without an active cloud billing API key.
 * @private
 */
function generateDemoResponse_(question, context) {
  const scenario = context.scenario_id || 'Base (Actuals)';
  const tab = context.tab || 'Executive Dashboard';
  const pos = context.selected_pos || 'Consolidated Network';

  return `💡 **[PORTFOLIO DEMO MODE - V.I.A. ENGINE]**\n` +
    `*No active Gemini API key detected in ScriptProperties. Presenting contextual UI-RAG simulation:*` +
    `\n\n` +
    `**FP&A Executive Summary for [${pos}]:**\n` +
    `* **Contextual Grounding:** You are currently analyzing the **${tab}** under the **${scenario}** scenario.\n` +
    `* **Simulated Insight:** Based on typical network parameters, a query regarding *"_${question}_"* indicates that fixed OPEX absorption is stabilizing. The projected EBITDA margin variation is trending at **+140 bps** compared to the baseline.\n` +
    `* **Recommended Action:** To execute a real-time stress test, adjust the logistics freight driver in the Simulator tab by +3.5% and observe the waterfall cascade.\n` +
    `\n*To enable real-time generative AI inference, configure a Free Tier key from Google AI Studio in the project's ScriptProperties.*`;
}

// ---------------------------------------------------------------------------
// 3. PAYLOAD & RAG BUILDERS
// ---------------------------------------------------------------------------

/**
 * Serializes the frontend UI state into a structured Markdown block for the LLM.
 * @private
 */
function buildUIContextString_(context) {
  const filters = context.filters ? JSON.stringify(context.filters) : 'None (Global View)';
  const kpis = context.visible_kpis ? JSON.stringify(context.visible_kpis) : 'Not provided in context';

  return `
--- ACTIVE UI-RAG CONTEXT ---
* Current Module/Tab: ${context.tab || 'Executive Dashboard'}
* Active Filters: ${filters}
* Selected POS Scope: ${context.selected_pos || 'Consolidated Network (All POS)'}
* Simulation Scenario: ${context.scenario_id || 'Base (Actuals)'}
* Target Fiscal Year: ${context.year || '2026'}
* Visible Screen KPIs: ${kpis}
-----------------------------`.trim();
}

/**
 * Constructs the native v1beta payload utilizing dedicated system_instruction
 * and structuring conversational turns cleanly.
 * @private
 */
function buildGeminiPayload_(currentQuestion, ragContext, history) {
  // Map conversation history to Gemini schema
  const formattedHistory = history.map(msg => ({
    role: msg.role === 'model' || msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(msg.text) }]
  }));

  // Append current question enriched with real-time UI context
  const currentTurn = {
    role: "user",
    parts: [{ text: `${ragContext}\n\nUser Question: ${currentQuestion}` }]
  };

  return {
    // Native System Instruction separation (Best Practice for Gemini API)
    system_instruction: {
      parts: [{ text: VIA_SYSTEM_INSTRUCTION }]
    },
    // Combine Few-Shot examples, conversation history, and current turn
    contents: [
      ...FEW_SHOT_EXAMPLES,
      ...formattedHistory,
      currentTurn
    ],
    generationConfig: {
      temperature: VIA_CONFIG.TEMPERATURE,
      maxOutputTokens: VIA_CONFIG.MAX_OUTPUT_TOKENS,
      topP: 0.95
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
    ]
  };
}

// ---------------------------------------------------------------------------
// 4. RESILIENT API CLIENT (EXPONENTIAL BACKOFF)
// ---------------------------------------------------------------------------

/**
 * Executes the REST API call with retry logic for HTTP 429 (Rate Limit) and 503 (Unavailable).
 * @private
 */
function executeGeminiRequestWithRetry_(payload, apiKey) {
  const url = `https://generativelanguage.googleapis.com/${VIA_CONFIG.API_VERSION}/models/${VIA_CONFIG.MODEL}:generateContent?key=${apiKey}`;
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let attempt = 0;
  let backoff = VIA_CONFIG.INITIAL_BACKOFF_MS;

  while (attempt < VIA_CONFIG.MAX_RETRIES) {
    attempt++;
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    // Success
    if (responseCode === 200) {
        const json = JSON.parse(responseText);
        if (json.candidates && json.candidates.length > 0) {
            const candidate = json.candidates[0];

            // Defensive check for blocking or truncation
            if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
                throw new Error(`Gemini API execution halted by safety policy: ${candidate.finishReason}`);
            }

            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                return candidate.content.parts[0].text.trim();
            }
        }
        throw new Error('Gemini API returned 200 OK but candidate payload was malformed or empty.');
    }

    // Handle Transient Errors (Rate limiting or server overload)
    if (responseCode === 429 || responseCode >= 500) {
      console.warn(`[VIA_Agent] HTTP ${responseCode} on attempt ${attempt}. Retrying in ${backoff}ms...`);
      if (attempt === VIA_CONFIG.MAX_RETRIES) {
        throw new Error(`Gemini API exhausted retries. Last status: ${responseCode} - ${responseText}`);
      }
      Utilities.sleep(backoff);
      backoff *= 2; // Double the wait time (Exponential Backoff)
      continue;
    }

    // Fatal Client Errors (400 Bad Request, 403 Forbidden, etc.)
    throw new Error(`Gemini API Fatal Error (${responseCode}): ${responseText}`);
  }
}

// ---------------------------------------------------------------------------
// 5. TELEMETRY HELPERS
// ---------------------------------------------------------------------------

function logTelemetryEvent_(event, data) {
  try {
    if (typeof TelemetryService !== 'undefined') TelemetryService.logEvent(event, data);
  } catch (e) { /* silent fail */ }
}

function logTelemetryError_(event, message, data) {
  try {
    if (typeof TelemetryService !== 'undefined') TelemetryService.logError(event, message, data);
  } catch (e) { /* silent fail */ }
}