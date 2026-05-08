# MADabolic Franchisee Survey (Short)

The 16 questions to ask other franchisees so you can dump their data into the site selector as additional benchmarks. Use any tool you want (Typeform, Google Form, email, phone call). The data goes into `data/locations.seed.json` or via the admin API.

---

## Questions

1. Studio name and full street address
2. Year and month opened
3. Class capacity (20 or 25)
4. Cost of a 12-month membership
5. Cost of a month-to-month membership
6. Current number of active members
7. Highest member count ever achieved
8. Average leads per month
9. Average trials per month
10. Average new members per month
11. Average terminations per month
12. Percentage of members on no-commitment vs 12-month commitment (e.g. 60/40)
13. Approximate male / female split (e.g. 55/45)
14. Estimated average age of active members
15. Other competitors in a 2-mile radius (list them)
16. Is parking a big issue? (Yes / Somewhat / No)

---

## Adding Their Data to the Tool

Once you have a franchisee's answers, paste them into your Claude chat or use the admin API directly. Either way, each new location adds a benchmark for future site evaluations to compare against.

### Quick admin API example

```bash
curl -X POST https://YOUR-DOMAIN/api/admin/locations \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{
    "id": "charleston-sc",
    "studio_address": "MADabolic Charleston, 123 Main St, Charleston SC",
    "opened_date": "2022-03",
    "class_capacity": 25,
    "price_12_month": 269,
    "price_month_to_month": 329,
    "current_members": 312,
    "peak_members": 340,
    "avg_leads": 80,
    "avg_trials": 28,
    "avg_new_members": 18,
    "avg_terminations": 14,
    "commitment_split": "55/45",
    "gender_split": "60/40",
    "avg_member_age": 36,
    "competitors_2mi": "F45, OrangeTheory, Solidcore, CrossFit Holy City",
    "parking_issue": "Somewhat",
    "performance_tier": "top",
    "performance_label": "Charleston franchisee — strong retention",
    "demographic_scores": {
      "stability": 17, "psychographics": 13, "walkability": 10,
      "competition": 7, "density": 7, "income": 9, "lifestyle": 9,
      "housing": 7, "hybrid": 4
    },
    "notes": "Walkable historic district. Strong retention. Older average age."
  }'
```

The `demographic_scores` are the 9-variable scoring breakdown. If you don't know what scores to assign, paste the franchisee's answers into Claude chat and ask for an estimate based on the framework.
