/**
 * =============================================================================
 * COST SIMULATION ENGINE – DATA SERVICE (BIGQUERY CONNECTOR)
 * Repository: cost-simulation-engine
 * Architecture: Serverless FinOps Data Access Layer (DAL)
 * Description: Executes strict parametrized SQL against Google BigQuery.
 *              Features automatic type serialization, bulk MERGE DML operations,
 *              and multi-statement transactional execution for LRP simulations.
 * Runtime: Google Apps Script (V8 Engine)
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// 1. BIGQUERY CLIENT HELPER & TYPE SERIALIZER
// ---------------------------------------------------------------------------

/**
 * Executes a parametrized SQL query against BigQuery with automated retry logic
 * and advanced parameter type serialization.
 *
 * @param {string} queryString - SQL query with @param placeholders.
 * @param {Object} [params={}] - Key-value pair of named parameters.
 * @returns {Array<Object>} Array of JSON rows formatted for UI consumption.
 */
function executeQuery(queryString, params = {}) {
  const maxRetries = CONFIG.MAX_RETRIES || 3;
  let lastError;

  // Build strict BigQuery API V2 parameter structure
  const formattedParams = buildQueryParameters_(params);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const request = {
        query: queryString,
        useLegacySql: false,
        timeoutMs: 30000
      };

      // Only attach queryParameters if variables exist to prevent API schema validation errors
      if (formattedParams.length > 0) {
        request.queryParameters = formattedParams;
      }

      const result = BigQuery.Jobs.query(request, CONFIG.PROJECT_ID);
      const rows = [];

      // Convert BigQuery REST columnar format to standard JS Object Array
      if (result.jobComplete && result.rows) {
        const schema = result.schema.fields.map(f => f.name);
        result.rows.forEach(row => {
          const obj = {};
          schema.forEach((col, idx) => {
            const rawVal = row.f[idx].v;
            // Normalize numeric strings returned by BigQuery to JS Numbers where appropriate
            obj[col] = (rawVal !== null && !isNaN(rawVal) && rawVal !== '') ? Number(rawVal) : rawVal;
          });
          rows.push(obj);
        });
      }

      return rows;

    } catch (err) {
      lastError = err;
      console.error(`[DataService] Query attempt ${attempt}/${maxRetries} failed: ${err.message}`);

      if (typeof TelemetryService !== 'undefined') {
        TelemetryService.logError('BIGQUERY_QUERY_FAILURE', err.message, {
          attempt: attempt,
          queryPreview: queryString.substring(0, 150)
        });
      }

      if (attempt === maxRetries) break;
      Utilities.sleep(1000 * Math.pow(2, attempt)); // Exponential backoff
    }
  }

  throw new Error(`BigQuery execution failed after ${maxRetries} attempts: ${lastError.message}`);
}

/**
 * Internal helper: Converts standard JS objects into BigQuery API v2 queryParameters schema.
 * Prevents SQL Injection and resolves type mismatch errors in Apps Script.
 *
 * @private
 * @param {Object} params - Key-value parameters.
 * @returns {Array<Object>} BigQuery API formatted parameters.
 */
function buildQueryParameters_(params) {
  return Object.keys(params).map(key => {
    const val = params[key];
    let type = 'STRING';

    if (typeof val === 'number') {
      type = Number.isInteger(val) ? 'INT64' : 'FLOAT64';
    } else if (typeof val === 'boolean') {
      type = 'BOOL';
    }

    return {
      name: key,
      parameterType: { type: type },
      parameterValue: { value: val === null ? null : String(val) }
    };
  });
}

// ---------------------------------------------------------------------------
// 2. EXECUTIVE DASHBOARD DATA READERS
// ---------------------------------------------------------------------------

/**
 * Returns CAGR cards (GMV, Net Revenue, Gross Margin, EBITDA).
 * Corresponds to: sql/simulation_queries.sql (Query 1 - CAGR Cards)
 */
function getCAGRCards(scenarioId, startYear, endYear) {
  const query = `
    WITH metrics_pivot AS (
      SELECT 
        line_item_id,
        CASE line_item_id
          WHEN 1 THEN 'GMV'
          WHEN 2 THEN 'Net Revenue'
          WHEN 3 THEN 'Gross Margin'
          WHEN 10 THEN 'EBITDA'
        END AS metric,
        SUM(CASE WHEN EXTRACT(YEAR FROM year_month) = @start_year THEN amount ELSE 0 END) AS value_start,
        SUM(CASE WHEN EXTRACT(YEAR FROM year_month) = @end_year THEN amount ELSE 0 END) AS value_end
      FROM \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_pl_monthly\`
      WHERE scenario_id = @scenario_id
        AND line_item_id IN (1, 2, 3, 10)
        AND EXTRACT(YEAR FROM year_month) IN (@start_year, @end_year)
      GROUP BY line_item_id
    )
    SELECT 
      metric, 
      value_end AS absolute_value,
      CASE 
        WHEN value_start > 0 AND value_end >= 0 AND @end_year > @start_year
        THEN ROUND(CAST(POWER(value_end / value_start, 1.0 / (@end_year - @start_year)) - 1 AS NUMERIC), 6)
        ELSE NULL 
      END AS cagr_decimal
    FROM metrics_pivot
    ORDER BY line_item_id
  `;

  return executeQuery(query, {
    scenario_id: scenarioId,
    start_year: parseInt(startYear),
    end_year: parseInt(endYear)
  });
}

/**
 * Returns summary table with YoY growth by state and region.
 * Corresponds to: sql/simulation_queries.sql (Query 2 - Summary Table)
 */
function getYoYSummary(scenarioId, currentYear) {
  const query = `
    WITH regional_aggregation AS (
      SELECT 
        d.state, 
        d.region, 
        f.line_item_id,
        SUM(CASE WHEN EXTRACT(YEAR FROM f.year_month) = @current_year THEN f.amount ELSE 0 END) AS curr_amt,
        SUM(CASE WHEN EXTRACT(YEAR FROM f.year_month) = @current_year - 1 THEN f.amount ELSE 0 END) AS prev_amt
      FROM \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_pl_monthly\` f
      JOIN \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.dim_pos\` d ON f.pos_id = d.pos_id
      WHERE f.scenario_id = @scenario_id
        AND f.line_item_id IN (1, 2, 3, 10)
        AND EXTRACT(YEAR FROM f.year_month) IN (@current_year, @current_year - 1)
      GROUP BY d.state, d.region, f.line_item_id
    ),
    pivoted AS (
      SELECT 
        state, 
        region,
        SUM(CASE WHEN line_item_id = 1 THEN curr_amt ELSE 0 END) AS total_gmv,
        SUM(CASE WHEN line_item_id = 1 THEN prev_amt ELSE 0 END) AS prev_gmv,
        SUM(CASE WHEN line_item_id = 2 THEN curr_amt ELSE 0 END) AS total_net_revenue,
        SUM(CASE WHEN line_item_id = 2 THEN prev_amt ELSE 0 END) AS prev_net_revenue,
        SUM(CASE WHEN line_item_id = 3 THEN curr_amt ELSE 0 END) AS total_gross_margin,
        SUM(CASE WHEN line_item_id = 3 THEN prev_amt ELSE 0 END) AS prev_gross_margin,
        SUM(CASE WHEN line_item_id = 10 THEN curr_amt ELSE 0 END) AS total_ebitda,
        SUM(CASE WHEN line_item_id = 10 THEN prev_amt ELSE 0 END) AS prev_ebitda
      FROM regional_aggregation
      GROUP BY state, region
    )
    SELECT 
      state, 
      region,
      total_gmv, 
      total_net_revenue, 
      total_gross_margin, 
      total_ebitda,
      CASE WHEN prev_gmv > 0 THEN ROUND(CAST((total_gmv - prev_gmv) / prev_gmv AS NUMERIC), 4) ELSE NULL END AS gmv_yoy,
      CASE WHEN prev_net_revenue > 0 THEN ROUND(CAST((total_net_revenue - prev_net_revenue) / prev_net_revenue AS NUMERIC), 4) ELSE NULL END AS net_revenue_yoy,
      CASE WHEN prev_gross_margin > 0 THEN ROUND(CAST((total_gross_margin - prev_gross_margin) / prev_gross_margin AS NUMERIC), 4) ELSE NULL END AS gross_margin_yoy,
      CASE WHEN prev_ebitda > 0 THEN ROUND(CAST((total_ebitda - prev_ebitda) / prev_ebitda AS NUMERIC), 4) ELSE NULL END AS ebitda_yoy
    FROM pivoted
    ORDER BY total_gmv DESC
  `;

  return executeQuery(query, {
    scenario_id: scenarioId,
    current_year: parseInt(currentYear)
  });
}

/**
 * Returns waterfall data (EBITDA levers) for bridge chart.
 * Corresponds to: sql/simulation_queries.sql (Query 3 - Waterfall)
 */
function getWaterfall(scenarioId, startYear, endYear) {
  const query = `
    WITH levers_variation AS (
      SELECT 
        dc.driver_group AS lever_name,
        SUM(fmc.budget_amount - fmc.actual_amount) AS accumulated_variation
      FROM \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_monthly_cost\` fmc
      JOIN \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.dim_cost_driver\` dc ON fmc.driver_id = dc.driver_id
      WHERE fmc.scenario_id = @scenario_id
        AND EXTRACT(YEAR FROM fmc.year_month) BETWEEN @start_year AND @end_year
      GROUP BY dc.driver_group
    )
    SELECT 
      lever_name, 
      accumulated_variation,
      SUM(accumulated_variation) OVER (ORDER BY accumulated_variation DESC, lever_name ASC) AS running_total
    FROM levers_variation
    ORDER BY accumulated_variation DESC, lever_name ASC
  `;

  return executeQuery(query, {
    scenario_id: scenarioId,
    start_year: parseInt(startYear),
    end_year: parseInt(endYear)
  });
}

/**
 * Returns territorial GMV and EBITDA for scatter plot and ECharts maps.
 */
function getScatter(scenarioId, currentYear) {
  return getStateLevelMetrics(scenarioId, currentYear);
}

function getMapData(scenarioId, currentYear) {
  return getStateLevelMetrics(scenarioId, currentYear);
}

function getStateLevelMetrics(scenarioId, currentYear) {
  const query = `
    WITH state_metrics AS (
      SELECT 
        d.state,
        SUM(CASE WHEN f.line_item_id = 1 THEN f.amount ELSE 0 END) AS gmv,
        SUM(CASE WHEN f.line_item_id = 10 THEN f.amount ELSE 0 END) AS ebitda
      FROM \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_pl_monthly\` f
      JOIN \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.dim_pos\` d ON f.pos_id = d.pos_id
      WHERE f.scenario_id = @scenario_id
        AND EXTRACT(YEAR FROM f.year_month) = @current_year
      GROUP BY d.state
    )
    SELECT 
      state, 
      gmv, 
      ebitda,
      CASE WHEN gmv > 0 THEN ROUND(CAST(ebitda / gmv AS NUMERIC), 4) ELSE NULL END AS ebitda_margin_pct
    FROM state_metrics
    ORDER BY gmv DESC
  `;

  return executeQuery(query, {
    scenario_id: scenarioId,
    current_year: parseInt(currentYear)
  });
}

// ---------------------------------------------------------------------------
// 3. P&L HIERARCHY DATA (SIMULATOR & DETAILED DRE)
// ---------------------------------------------------------------------------

function getPLLineItems(scenarioId, year, posId) {
  return getPLData(scenarioId, year, posId, 2);
}

function getDetailedPL(scenarioId, year, posId) {
  return getPLData(scenarioId, year, posId, null);
}

/**
 * Dynamic P&L fetcher with defensive SQL stitching for POS and Level filtering.
 */
function getPLData(scenarioId, year, posId, maxLevel) {
  let levelFilter = '';
  let posFilter = '';
  const params = {
    scenario_id: scenarioId,
    year: parseInt(year)
  };

  if (maxLevel !== null) {
    levelFilter = 'AND pl.level <= @max_level';
    params.max_level = maxLevel;
  }

  // Optimize SQL execution plan: Only inject POS filter if a specific POS is requested
  if (posId && posId !== 'ALL') {
    posFilter = 'AND f.pos_id = @pos_id';
    params.pos_id = posId;
  }

  const query = `
    SELECT 
      pl.line_item_id, 
      pl.line_item_name, 
      pl.parent_id, 
      pl.level, 
      pl.sign,
      SUM(f.amount) AS total_amount
    FROM \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_pl_monthly\` f
    JOIN \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.dim_pl_structure\` pl ON f.line_item_id = pl.line_item_id
    WHERE f.scenario_id = @scenario_id
      AND EXTRACT(YEAR FROM f.year_month) = @year
      ${posFilter}
      ${levelFilter}
    GROUP BY pl.line_item_id, pl.line_item_name, pl.parent_id, pl.level, pl.sign
    ORDER BY pl.line_item_id
  `;

  return executeQuery(query, params);
}

// ---------------------------------------------------------------------------
// 4. ENTERPRISE SCENARIO MANAGEMENT (TRANSACTIONS & BULK MERGE)
// ---------------------------------------------------------------------------

/**
 * Creates a new simulation scenario using an Atomic Multi-Statement Transaction.
 * Prevents partial data copies and executes in a single BigQuery job roundtrip.
 *
 * @param {string} name - Display name for the new scenario.
 * @param {string} userEmail - Creator session identifier.
 * @param {string} baselineId - Source scenario ID to clone.
 * @returns {string} The newly generated UUID for the scenario.
 */
function createScenario(name, userEmail, baselineId) {
  const newScenarioId = Utilities.getUuid();

  // Multi-statement transactional block: All copy operations succeed or rollback entirely
  const atomicCloneScript = `
    BEGIN TRANSACTION;
    
      -- 1. Insert Metadata
      INSERT INTO \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.dim_scenario\`
        (scenario_id, scenario_name, created_by, created_at, description, is_baseline)
      VALUES 
        (@new_id, @name, @user, CURRENT_TIMESTAMP(), 'Custom LRP Simulation', FALSE);

      -- 2. Clone Cost Fact Records
      INSERT INTO \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_monthly_cost\`
        (pos_id, year_month, driver_id, actual_amount, budget_amount, scenario_id)
      SELECT 
        pos_id, year_month, driver_id, actual_amount, budget_amount, @new_id
      FROM \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_monthly_cost\`
      WHERE scenario_id = @baseline;

      -- 3. Clone P&L Fact Records
      INSERT INTO \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_pl_monthly\`
        (pos_id, year_month, line_item_id, amount, scenario_id)
      SELECT 
        pos_id, year_month, line_item_id, amount, @new_id
      FROM \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_pl_monthly\`
      WHERE scenario_id = @baseline;

    COMMIT TRANSACTION;
  `;

  executeQuery(atomicCloneScript, {
    new_id: newScenarioId,
    name: name,
    user: userEmail,
    baseline: baselineId
  });

  return newScenarioId;
}

/**
 * Applies user driver overrides using a BULK MERGE DML statement.
 * Eliminates iterative UPDATE loops, preventing API quota exhaustion and UI latency.
 *
 * @param {string} scenarioId - Target scenario to update.
 * @param {Array<Object>} overrides - Array of {pos_id, driver_id, new_value}.
 */
function applyOverrides(scenarioId, overrides) {
  if (!overrides || overrides.length === 0) return;

  // Build dynamic SQL UNION table to feed the bulk MERGE statement in a single job
  const unnestQueries = overrides.map((ov, idx) => {
    // Sanitize numeric inputs to prevent SQL syntax injection inside the string builder
    const cleanVal = Number(ov.new_value) || 0;
    const cleanDriver = parseInt(ov.driver_id, 10);
    // Use alphanumeric clean identifiers for string matching
    const cleanPos = String(ov.pos_id).replace(/[^a-zA-Z0-9_]/g, '');
    
    return `SELECT '${cleanPos}' AS pos_id, ${cleanDriver} AS driver_id, CAST(${cleanVal} AS NUMERIC) AS new_value`;
  });

  const bulkMergeQuery = `
    WITH override_payload AS (
      ${unnestQueries.join(' UNION ALL \n      ')}
    )
    MERGE INTO \`${CONFIG.PROJECT_ID}.${CONFIG.DATASET}.fact_monthly_cost\` target
    USING override_payload source
    ON target.scenario_id = @scenario_id
       AND target.pos_id = source.pos_id
       AND target.driver_id = source.driver_id
    WHEN MATCHED THEN
      UPDATE SET budget_amount = source.new_value;
  `;

  executeQuery(bulkMergeQuery, {
    scenario_id: scenarioId
  });
}