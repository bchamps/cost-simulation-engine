# =============================================================================
# COST SIMULATION ENGINE – SYNTHETIC DATA GENERATOR (ENTERPRISE GRADE)
# Repository: cost-simulation-engine
# Author: Bruno Campos
# Description: Generates deterministic, GAAP-compliant synthetic data for 4,400+
#              franchise Points of Sale (POS) across all 27 Brazilian UFs.
#              ARCHITECTURAL HIGHLIGHT: Implements Mixed-Granularity Time Series.
#              Historical/Current cycles (2024-2026) are generated monthly, while
#              Long-Range Planning (LRP 2027-2030) is generated annually, cutting
#              cloud data volume by >50% and mirroring real C-level macro-levers.
# Dependencies: pandas, numpy (pip install pandas numpy)
# Usage: python generate_synthetic_data.py
# =============================================================================

import pandas as pd
import numpy as np
from datetime import datetime

# ---------------------------------------------------------------------------
# 1. GLOBAL CONFIGURATION & FINOPS DETERMINISM
# ---------------------------------------------------------------------------
np.random.seed(42)  # Enforces absolute reproducibility for technical audits

NUM_POS = 4400
START_HIST_YEAR = 2024
END_HIST_YEAR = 2026
START_LRP_YEAR = 2027
END_LRP_YEAR = 2030
CURRENT_CLOSE_DATE = '2026-06-01'  # Actuals cutoff; future dates get NULL actuals
SCENARIOS = ['base', 'scenario_A', 'rolling_forecast_q3']

# Complete mapping of 27 Brazilian UFs with realistic macroeconomic weighting
UF_MAPPING = [
    ('SP', 'Southeast', 0.28), ('RJ', 'Southeast', 0.10), ('MG', 'Southeast', 0.09), ('ES', 'Southeast', 0.02),
    ('PR', 'South', 0.07),     ('RS', 'South', 0.06),     ('SC', 'South', 0.05),
    ('BA', 'Northeast', 0.06), ('PE', 'Northeast', 0.04), ('CE', 'Northeast', 0.04), ('MA', 'Northeast', 0.02),
    ('PB', 'Northeast', 0.01), ('RN', 'Northeast', 0.01), ('AL', 'Northeast', 0.01), ('PI', 'Northeast', 0.01), ('SE', 'Northeast', 0.01),
    ('GO', 'Mid-West', 0.03),  ('DF', 'Mid-West', 0.02),  ('MT', 'Mid-West', 0.02),  ('MS', 'Mid-West', 0.01),
    ('PA', 'North', 0.01),     ('AM', 'North', 0.01),     ('RO', 'North', 0.005),    ('TO', 'North', 0.005),
    ('AC', 'North', 0.003),    ('AP', 'North', 0.004),    ('RR', 'North', 0.003)
]

UFS = [x[0] for x in UF_MAPPING]
REGIONS = {x[0]: x[1] for x in UF_MAPPING}
# Normalize weights to exactly 1.0 to prevent NumPy probability distribution drift
WEIGHTS = np.array([x[2] for x in UF_MAPPING]) / np.sum([x[2] for x in UF_MAPPING])

# MIXED-GRANULARITY TIMELINE GENERATION
# 1. Monthly dates for Historical & Rolling Forecast (2024-01-01 to 2026-12-01)
HIST_DATES = pd.date_range(start=f'{START_HIST_YEAR}-01-01', end=f'{END_HIST_YEAR}-12-01', freq='MS').strftime('%Y-%m-%d').tolist()
# 2. Annual dates for Long-Range Planning (2027-01-01 to 2030-01-01, representing full macro-years)
LRP_DATES = [f'{y}-01-01' for y in range(START_LRP_YEAR, END_LRP_YEAR + 1)]

ALL_DATES = HIST_DATES + LRP_DATES
print(f"[INFO] Timeline initialized: {len(HIST_DATES)} monthly periods + {len(LRP_DATES)} annual LRP periods per POS.")

# ---------------------------------------------------------------------------
# 2. DIMENSION: dim_pos
# ---------------------------------------------------------------------------
def generate_dim_pos():
    pos_ids = [f"POS_{i:04d}" for i in range(1, NUM_POS + 1)]
    states = np.random.choice(UFS, NUM_POS, p=WEIGHTS)
    cities = [f"City_{i%100:03d}_{s}" for i, s in enumerate(states)]
    sizes = np.random.choice(['Small', 'Medium', 'Large'], NUM_POS, p=[0.35, 0.45, 0.20])
    channels = np.random.choice(['Mall', 'Street', 'Online'], NUM_POS, p=[0.45, 0.45, 0.10])
    
    start_num = datetime(2016, 1, 1).toordinal()
    end_num = datetime(2023, 12, 31).toordinal()
    random_days = np.random.randint(start_num, end_num, NUM_POS)
    opening_dates = [datetime.fromordinal(d).strftime('%Y-%m-%d') for d in random_days]

    df = pd.DataFrame({
        'pos_id': pos_ids,
        'region': [REGIONS[s] for s in states],
        'state': states,
        'city': cities,
        'size_category': sizes,
        'channel': channels,
        'opening_date': opening_dates
    })
    df.to_csv('dim_pos.csv', index=False)
    print(f"[OK] dim_pos.csv generated ({len(df):,} records - All 27 UFs covered).")
    return df

# ---------------------------------------------------------------------------
# 3. DIMENSIONS: dim_cost_driver & dim_scenario
# ---------------------------------------------------------------------------
def generate_dim_cost_driver():
    drivers = [
        (1, 'Rent', 'Fixed', True),          (2, 'Labor', 'Semi-Variable', True),
        (3, 'Marketing', 'Variable', True),  (4, 'Logistics', 'Variable', False),
        (5, 'Packaging', 'Variable', True),  (6, 'Utilities', 'Semi-Variable', False),
        (7, 'Maintenance', 'Fixed', True),   (8, 'Taxes', 'Fixed', False),
        (9, 'Insurance', 'Fixed', False),    (10, 'Administrative', 'Fixed', True)
    ]
    df = pd.DataFrame(drivers, columns=['driver_id', 'driver_name', 'driver_group', 'is_controllable'])
    df.to_csv('dim_cost_driver.csv', index=False)
    print(f"[OK] dim_cost_driver.csv generated ({len(df)} records).")

def generate_dim_scenario():
    scenarios = [
        ('base', 'Base Scenario', 'admin', '2024-01-01 00:00:00', 'Official LRP baseline budget', True),
        ('scenario_A', 'Scenario A', 'admin', '2024-06-01 00:00:00', 'Pessimistic macro outlook', False),
        ('rolling_forecast_q3', 'Rolling Forecast Q3', 'admin', '2025-09-01 00:00:00', 'Updated rolling projection', False)
    ]
    df = pd.DataFrame(scenarios, columns=['scenario_id', 'scenario_name', 'created_by', 'created_at', 'description', 'is_baseline'])
    df.to_csv('dim_scenario.csv', index=False)
    print(f"[OK] dim_scenario.csv generated ({len(df)} records).")

# ---------------------------------------------------------------------------
# 4. DIMENSION: dim_pl_structure
# ---------------------------------------------------------------------------
def generate_dim_pl_structure():
    pl = [
        (1, 'Gross Revenue', None, 1, 1),      (2, 'Deductions', 1, 2, -1),
        (3, 'Net Revenue', 1, 1, 1),           (4, 'COGS', 3, 2, -1),
        (5, 'Gross Margin', 3, 1, 1),          (6, 'Operating Expenses', 5, 2, -1),
        (7, 'Selling Expenses', 6, 3, -1),     (8, 'G&A', 6, 3, -1),
        (9, 'EBIT', 5, 1, 1),                  (10, 'EBITDA', 9, 1, 1)
    ]
    df = pd.DataFrame(pl, columns=['line_item_id', 'line_item_name', 'parent_id', 'level', 'sign'])
    df.to_csv('dim_pl_structure.csv', index=False)
    print(f"[OK] dim_pl_structure.csv generated ({len(df)} records).")

# ---------------------------------------------------------------------------
# 5. FACT: fact_pl_monthly (Vectorized Mixed-Granularity P&L)
# ---------------------------------------------------------------------------
def generate_fact_pl_monthly(df_pos):
    print("Generating fact_pl_monthly (Vectorized Mixed-Granularity across full POS network)...")
    
    idx = pd.MultiIndex.from_product([df_pos['pos_id'], ALL_DATES, SCENARIOS], names=['pos_id', 'year_month', 'scenario_id'])
    df_fact = pd.DataFrame(index=idx).reset_index()
    df_fact = df_fact.merge(df_pos[['pos_id', 'state', 'size_category']], on='pos_id', how='left')
    
    size_mult = df_fact['size_category'].map({'Small': 0.6, 'Medium': 1.0, 'Large': 1.8})
    sp_outlier = np.where(df_fact['state'] == 'SP', 3.2, np.where(df_fact['state'].isin(['RJ', 'MG', 'PR']), 1.4, 1.0))
    
    # Identify if record is LRP (Annual) or Historical/Rolling (Monthly)
    is_lrp = df_fact['year_month'].isin(LRP_DATES)
    years = pd.to_datetime(df_fact['year_month']).dt.year
    months = pd.to_datetime(df_fact['year_month']).dt.month
    
    # Seasonality applies exclusively to monthly records; LRP annual gets a neutral 1.0 factor
    seasonality = np.where(is_lrp, 1.0, 1 + 0.18 * np.sin(2 * np.pi * months / 12))
    
    # Scale multiplier: LRP annual records represent 12 months of revenue + annual compounding macro-growth (6% p.a.)
    lrp_compounding = np.where(is_lrp, 12.0 * ((1.06) ** (years - START_HIST_YEAR)), 1.0)
    
    base_rev = np.random.lognormal(mean=10.2, sigma=0.4, size=len(df_fact)) * size_mult * sp_outlier * seasonality * lrp_compounding
    
    # Enforce strict GAAP/IFRS algebraic relationships
    gross_rev = base_rev
    deductions = gross_rev * np.random.uniform(0.12, 0.16, size=len(df_fact))
    net_rev = gross_rev - deductions
    cogs = net_rev * np.random.uniform(0.48, 0.55, size=len(df_fact))
    gross_margin = net_rev - cogs
    
    selling_exp = gross_margin * np.random.uniform(0.18, 0.22, size=len(df_fact))
    ga_exp = gross_margin * np.random.uniform(0.08, 0.12, size=len(df_fact))
    opex = selling_exp + ga_exp
    ebitda = gross_margin - opex
    ebit = ebitda - (gross_margin * 0.03)  # Proxy for Depreciation & Amortization
    
    lines_map = {
        1: gross_rev, 2: deductions, 3: net_rev, 4: cogs, 5: gross_margin,
        6: opex, 7: selling_exp, 8: ga_exp, 9: ebit, 10: ebitda
    }
    
    records = []
    for line_id, values in lines_map.items():
        temp = df_fact[['pos_id', 'year_month', 'scenario_id']].copy()
        temp['line_item_id'] = line_id
        temp['amount'] = np.round(values, 2)
        records.append(temp)
        
    df_final = pd.concat(records, ignore_index=True)
    df_final.to_csv('fact_pl_monthly.csv', index=False)
    print(f"[OK] fact_pl_monthly.csv generated ({len(df_final):,} records - Mixed-Granularity GAAP DRE tied).")
    return df_fact, opex

# ---------------------------------------------------------------------------
# 6. FACT: fact_monthly_cost (Synchronized with OPEX & LRP Annual Scaling)
# ---------------------------------------------------------------------------
def generate_fact_monthly_cost(df_fact_base, opex_values):
    print("Generating fact_monthly_cost (Synchronized with OPEX & LRP Macro Levers)...")
    
    driver_weights = {
        1: 0.25, 2: 0.30, 3: 0.12, 4: 0.08, 5: 0.05,
        6: 0.05, 7: 0.04, 8: 0.05, 9: 0.03, 10: 0.03
    }
    
    records = []
    is_future = df_fact_base['year_month'] > CURRENT_CLOSE_DATE
    
    for driver_id, weight in driver_weights.items():
        temp = df_fact_base[['pos_id', 'year_month', 'scenario_id']].copy()
        temp['driver_id'] = driver_id
        
        # Budget is strictly proportional to generated OPEX (whether monthly or annual LRP)
        budget_val = opex_values * weight * np.random.normal(1.0, 0.03, size=len(temp))
        temp['budget_amount'] = np.round(budget_val, 2)
        
        # Actuals exist only for closed historical months; future months AND annual LRP get NULL (np.nan)
        actual_val = temp['budget_amount'] * np.random.normal(0.98, 0.04, size=len(temp))
        temp['actual_amount'] = np.where(is_future, np.nan, np.round(actual_val, 2))
        
        records.append(temp)
        
    df_final = pd.concat(records, ignore_index=True)
    df_final.to_csv('fact_monthly_cost.csv', index=False)
    print(f"[OK] fact_monthly_cost.csv generated ({len(df_final):,} records - LRP annual costs integrated).")

# =============================================================================
# 7. EXECUTION ORCHESTRATION
# =============================================================================
if __name__ == "__main__":
    print("="*70)
    print("STARTING ENTERPRISE SYNTHETIC DATA GENERATION (HYBRID LRP 2024-2030)")
    print("="*70)
    
    df_pos = generate_dim_pos()
    generate_dim_cost_driver()
    generate_dim_pl_structure()
    generate_dim_scenario()
    
    df_fact_base, opex_base = generate_fact_pl_monthly(df_pos)
    generate_fact_monthly_cost(df_fact_base, opex_base)
    
    print("="*70)
    print("[SUCCESS] All BigQuery CSV datasets generated with Mixed-Granularity LRP fidelity.")
    print("="*70)