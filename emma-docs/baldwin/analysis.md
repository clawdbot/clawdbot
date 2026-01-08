# The Baldwin at Woodmont Commons - EMMA Analysis

**Date:** January 8, 2026
**EMMA Issue ID:** P2415140
**URL:** https://emma.msrb.org/IssueView/Details/P2415140

## Bond Details
- **Issuer:** Business Finance Authority of the State of New Hampshire
- **Project:** The Baldwin at Woodmont Commons (CCRC)
- **Series:** 2022A, 2022B, 2022C, 2022D, 2022E
- **Total Issue:** $188,700,000
- **Dated:** April 21, 2022
- **Underwriter:** Odeon Capital Group LLC
- **Trustee:** UMB Bank, National Association

## Project Unit Mix
| Level of Care | Units | Notes |
|---------------|-------|-------|
| Independent Living | 190 | Apartments |
| Assisted Living / Memory Care | 40 | 4 households of 10 suites |
| **Total** | **230** | |

## Occupancy Performance (as of Dec 19, 2025)

### Independent Living
| Week Ending | Occupied | Occupancy % |
|-------------|----------|-------------|
| 10/27/2023 | 2 | 1.05% |
| 12/31/2023 | 52 | 27.37% |
| 6/30/2024 | 129 | 67.89% |
| 12/31/2024 | 155 | 81.58% |
| 6/30/2025 | 169 | 88.95% |
| **12/19/2025** | **188** | **98.95%** |

### Assisted Living / Memory Care
| Week Ending | Occupied | Occupancy % |
|-------------|----------|-------------|
| 5/24/2024 | 4 | 10.00% |
| 12/31/2024 | 11 | 27.50% |
| 6/30/2025 | 14 | 35.00% |
| **12/19/2025** | **23** | **57.50%** |

## Covenant Requirements

### Debt Service Coverage Ratio
- **Required:** ≥ 1.20 to 1.00
- **Testing Dates:** June 30 & December 31 (quarterly)
- **Calculation:** 
  - Through June 30, 2026: Trailing 6-month basis
  - September 30, 2026: Trailing 9-month basis
  - Thereafter: Trailing 12-month basis

**Default Triggers:**
- DSCR < 1.00 on any test date = Event of Default
- DSCR < 1.20 for 3 consecutive quarters = Event of Default
- DSCR < 1.20 for 2 consecutive quarters = Must hire Consultant

### Liquidity (Days Cash on Hand)
- **Required (with Support Agreement):** ≥ 90 Days
- **Required (after Support termination):** ≥ 100 Days
- **Testing Dates:** June 30 & December 31

**Default Triggers:**
- Days Cash < 70 on any test date = Event of Default
- Fails requirement 3 consecutive quarters = Event of Default

### Occupancy Requirements
Original projections from Official Statement:
| Quarter | IL Target | IL % | AL/MC Target | AL/MC % |
|---------|-----------|------|--------------|---------|
| Dec 2023 | 18 | 9.3% | - | - |
| Jun 2024 | 76 | 40.0% | 3 | 7.5% |
| Dec 2024 | 108 | 56.8% | 12 | 30.0% |
| Jun 2025 | 133 | 70.3% | 20 | 50.0% |
| Dec 2025 | 163 | 85.5% | 26 | 66.0% |
| Mar 2026 | 163 | 85.5% | 31 | 76.5% |

## Support Agreement Termination Conditions
Support Agreement terminates when ALL of:
1. Average occupancy ≥ 90% for 8 consecutive quarters
2. DSCR ≥ 1.40 (excluding Support Provider contributions)
3. Days Cash ≥ 100 (excluding Support Provider contributions)
4. Series 2022C and 2022D Bonds paid in full
5. All monthly payments current
6. Debt Service Reserve Fund at required level

## Data Sources Identified

### Available from EMMA (Continuing Disclosure)
- [x] Weekly Occupancy Reports
- [x] Monthly Presale/Marketing/Upgrades Reports
- [x] Quarterly Financial Reports (may need OCR)
- [x] Audited Financial Statements (annual)
- [x] Event Notices (bond calls, covenant amendments)
- [x] Official Statement (baseline covenants, projections)

### Not Available from EMMA
- Star ratings, health inspection deficiencies → CMS Care Compare
- Clinical quality metrics (falls, pressure ulcers, infections) → CMS/internal
- Staffing levels, turnover, agency usage → Internal systems
- Days in AR → Internal accounting
- Workers comp claims → Internal/insurance
- Competitor pricing → Market research
- Wage data → BLS, market surveys
- Housing market trends → Zillow/Redfin
- Hospital bed availability → State health department

## Document URLs
- Official Statement: https://emma.msrb.org/P21566762-P21210381-P21631244.pdf
- Q3 2025 Quarterly: https://emma.msrb.org/P21984754-P21513033-P21966933.pdf
- Occupancy (Dec 2025): https://emma.msrb.org/P11907629-P11457319-P11905310.pdf

## Technical Notes
- EMMA requires Terms of Use acceptance (cookie: `Disclaimer6=msrborg`)
- Direct downloads blocked without session cookies
- Some PDFs are image-based (Print to PDF) requiring OCR
- Browser automation works but print-to-PDF loses text
- Best approach: Extract cookies from browser session, use curl with cookies
