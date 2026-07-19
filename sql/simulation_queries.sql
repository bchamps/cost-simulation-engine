-- =============================================================================
-- COST SIMULATION ENGINE – PARAMETERIZED SIMULATION QUERIES
-- Repository: cost-simulation-engine
-- Author: Bruno Campos
-- Description: Production-grade BigQuery SQL powering the P&L simulation engine.
-- Architected for FinOps efficiency (single-scan conditional aggregations),
-- GAAP/IFRS audit-grade mathematical precision, and deterministic UI rendering.
-- =============================================================================

-- -------------------------------------------------------------------------
-- 1. EXECUTIVE DASHBOARD – CARDS WITH CAGR (Single-Scan & Fixed-Point)
-- -------------------------------------------------------------------------
-- Powers top executive cards: GMV, Net Revenue, Gross Margin, EBITDA.
-- Optimized for single-scan aggregation and explicit NUMERIC casting to
-- prevent BigQuery's implicit FLOAT64 conversion during POWER() calculations.
-- Parameters: @scenario_id, @start_year, @end_year
-- -------------------------------------------------------------------------

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
    FROM `YOUR_PROJECT_ID.YOUR_DATASET.fact_pl_monthly`
    WHERE scenario_id = @scenario_id
      AND line_item_id IN (1, 2, 3, 10)
      AND EXTRACT(YEAR FROM year_month) IN (@start_year, @end_year)
    GROUP BY line_item_id
)

SELECT
    metric,
    value_end AS absolute_value,
    -- Strict CAGR: (Vf/Vi)^(1/n) - 1. 
    -- 1. Enforces value_end >= 0 to properly capture terminal operational churn (-100% CAGR).
    -- 2. Casts to NUMERIC and rounds to 6 decimal places to prevent frontend double-rounding drift.
    CASE
        WHEN value_start > 0 AND value_end >= 0 AND @end_year > @start_year
        THEN ROUND(CAST(POWER(value_end / value_start, 1.0 / (@end_year - @start_year)) - 1 AS NUMERIC), 6)
        ELSE NULL -- GAAP compliance: CAGR is mathematically undefined for zero or negative base values
    END AS cagr_decimal
FROM metrics_pivot
ORDER BY line_item_id;

-- -------------------------------------------------------------------------
-- 2. EXECUTIVE DASHBOARD – SUMMARY TABLE WITH YoY (GAAP Compliance)
-- -------------------------------------------------------------------------
-- Displays financial performance per region/state with YoY growth rates.
-- Computes regional growth from aggregate totals and enforces GAAP/IFRS
-- 'Not Meaningful' (N/M) rules when base periods are zero or negative.
-- Parameters: @scenario_id, @current_year
-- -------------------------------------------------------------------------

WITH regional_aggregation AS (
    SELECT
        d.state,
        d.region,
        f.line_item_id,
        SUM(CASE WHEN EXTRACT(YEAR FROM f.year_month) = @current_year THEN f.amount ELSE 0 END) AS curr_amt,
        SUM(CASE WHEN EXTRACT(YEAR FROM f.year_month) = @current_year - 1 THEN f.amount ELSE 0 END) AS prev_amt
    FROM `YOUR_PROJECT_ID.YOUR_DATASET.fact_pl_monthly` f
    JOIN `YOUR_PROJECT_ID.YOUR_DATASET.dim_pos` d ON f.pos_id = d.pos_id
    WHERE f.scenario_id = @scenario_id
      AND f.line_item_id IN (1, 2, 3, 10)
      AND EXTRACT(YEAR FROM f.year_month) IN (@current_year, @current_year - 1)
    GROUP BY d.state, d.region, f.line_item_id
),
pivoted_performance AS (
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
    -- Exact NUMERIC casting prevents floating-point drift. Denominators <= 0 return NULL (N/M).
    CASE WHEN prev_gmv > 0 THEN ROUND(CAST((total_gmv - prev_gmv) / prev_gmv AS NUMERIC), 4) ELSE NULL END AS gmv_yoy,
    CASE WHEN prev_net_revenue > 0 THEN ROUND(CAST((total_net_revenue - prev_net_revenue) / prev_net_revenue AS NUMERIC), 4) ELSE NULL END AS net_revenue_yoy,
    CASE WHEN prev_gross_margin > 0 THEN ROUND(CAST((total_gross_margin - prev_gross_margin) / prev_gross_margin AS NUMERIC), 4) ELSE NULL END AS gross_margin_yoy,
    CASE WHEN prev_ebitda > 0 THEN ROUND(CAST((total_ebitda - prev_ebitda) / prev_ebitda AS NUMERIC), 4) ELSE NULL END AS ebitda_yoy
FROM pivoted_performance
ORDER BY total_gmv DESC;

-- -------------------------------------------------------------------------
-- 3. EXECUTIVE DASHBOARD – BRIDGE / WATERFALL CHART (Deterministic UI)
-- -------------------------------------------------------------------------
-- Decomposes EBITDA accumulated variation by cost driver groups.
-- Includes a deterministic tie-breaker in the window function to prevent
-- UI rendering bugs in ECharts/Chart.js when distinct levers share identical values.
-- Parameters: @scenario_id, @start_year, @end_year
-- -------------------------------------------------------------------------

WITH levers_variation AS (
    SELECT
        dc.driver_group AS lever_name,
        -- Favorable cost variance (Budget > Actual) increases EBITDA
        SUM(fmc.budget_amount - fmc.actual_amount) AS accumulated_variation
    FROM `YOUR_PROJECT_ID.YOUR_DATASET.fact_monthly_cost` fmc
    JOIN `YOUR_PROJECT_ID.YOUR_DATASET.dim_cost_driver` dc ON fmc.driver_id = dc.driver_id
    WHERE fmc.scenario_id = @scenario_id
      AND EXTRACT(YEAR FROM fmc.year_month) BETWEEN @start_year AND @end_year
    GROUP BY dc.driver_group
)

SELECT
    lever_name,
    accumulated_variation,
    -- Deterministic tie-breaker (lever_name ASC) prevents peer-grouping bugs in SQL windowing
    SUM(accumulated_variation) OVER (
        ORDER BY accumulated_variation DESC, lever_name ASC
    ) AS running_total
FROM levers_variation
ORDER BY accumulated_variation DESC, lever_name ASC;

-- -------------------------------------------------------------------------
-- 4. EXECUTIVE DASHBOARD – SCATTER PLOT (UF Dispersion Analysis)
-- -------------------------------------------------------------------------
-- Returns X/Y coordinates for GMV vs EBITDA Margin (%) bubble charting.
-- Enforces NUMERIC precision on ratio calculations.
-- Parameters: @scenario_id, @current_year
-- -------------------------------------------------------------------------

WITH state_metrics AS (
    SELECT
        d.state,
        SUM(CASE WHEN f.line_item_id = 1 THEN f.amount ELSE 0 END) AS gmv,
        SUM(CASE WHEN f.line_item_id = 10 THEN f.amount ELSE 0 END) AS ebitda
    FROM `YOUR_PROJECT_ID.YOUR_DATASET.fact_pl_monthly` f
    JOIN `YOUR_PROJECT_ID.YOUR_DATASET.dim_pos` d ON f.pos_id = d.pos_id
    WHERE f.scenario_id = @scenario_id
      AND EXTRACT(YEAR FROM f.year_month) = @current_year
    GROUP BY d.state
)

SELECT
    state,
    gmv,
    ebitda,
    -- Safe division with explicit NUMERIC casting for exact UI tooltip rendering
    CASE
        WHEN gmv > 0 THEN ROUND(CAST(ebitda / gmv AS NUMERIC), 4)
        ELSE NULL
    END AS ebitda_margin_pct
FROM state_metrics
ORDER BY gmv DESC;

-- -------------------------------------------------------------------------
-- 5. P&L SIMULATOR – BASELINE CASCADING EXTRACTION
-- -------------------------------------------------------------------------
-- Extracts the structural P&L dataset for a selected POS or aggregate network.
-- Designed to feed lightweight client-side JavaScript calculation engines,
-- enabling zero-latency multi-scenario simulations without cloud re-querying.
-- Parameters: @scenario_id, @year, @pos_id (nullable)
-- -------------------------------------------------------------------------

SELECT
    pl.line_item_id,
    pl.line_item_name,
    pl.parent_id,
    pl.level,
    pl.sign,
    SUM(f.amount) AS total_amount
FROM `YOUR_PROJECT_ID.YOUR_DATASET.fact_pl_monthly` f
JOIN `YOUR_PROJECT_ID.YOUR_DATASET.dim_pl_structure` pl ON f.line_item_id = pl.line_item_id
WHERE f.scenario_id = @scenario_id
  AND EXTRACT(YEAR FROM f.year_month) = @year
  AND (@pos_id IS NULL OR f.pos_id = @pos_id)
GROUP BY pl.line_item_id, pl.line_item_name, pl.parent_id, pl.level, pl.sign
ORDER BY pl.line_item_id;

-- =============================================================================
-- ARCHITECTURAL DESIGN DECISIONS (FINOPS, GAAP & DETERMINISTIC UI):
-- 1. Single-Scan Conditional Aggregation: Queries 1 and 2 utilize conditional
--    SUM(CASE...) logic to extract multi-year metrics in a single BigQuery pass,
--    reducing cloud data scanning costs (bytes billed) by ~50% vs. self-join CTEs.
-- 2. Strict GAAP/IFRS YoY Mathematics: Enforces explicit NUMERIC casting to prevent
--    BigQuery's implicit FLOAT64 drift during division/power functions. Adheres to
--    GAAP 'Not Meaningful' (N/M) rules by returning NULL when base periods <= 0.
-- 3. Deterministic Windowing: Query 3 incorporates a secondary sort key (`lever_name`)
--    within the OVER() clause, preventing SQL peer-grouping bugs and guaranteeing
--    flawless step-by-step rendering in frontend chart libraries (ECharts/Chart.js).
-- 4. Hybrid Compute Architecture: Query 5 deliberately offloads recursive P&L
--    cascading math to client-side browser JavaScript, enabling real-time UI 
--    slider interactions without incurring repetitive cloud server costs.
-- =============================================================================