# Issue #30: Implement Application Sorting & Filtering on Candidate Tracker

## 1. Problem Statement & Expected Outcomes
Students have no way to sort, filter, or search their applications on the "My Applications" page. 
**Goals:**
- Add a unified control bar containing: Search, Status Filter, and a new Sort Dropdown.
- Supported sort options: `Application Date (Newest)`, `Application Date (Oldest)`, `Last Updated Date`, and `AI Match Score`.
- Persist state via URL query parameters (`?search=...&status=...&sort=...`).
- Implement the actual backend query logic in `routes/user.js` and `routes/candidate.js`.

## 2. Implementation Steps

### Step 1: Update Backend Logic (`routes/user.js` and `routes/candidate.js`)
Currently, `router.get('/candidate/applications')` hardcodes `Application.find({ candidate: userId })` and `.sort({ appliedAt: -1 })`.
- Extract `req.query.sort` (default: `applied_desc`).
- Build a dynamic `query` object based on `req.query.status` (Submitted, Under Review, Shortlisted, Interview, Rejected, Withdrawn).
- Implement efficient MongoDB search by identifying matching `Internship` IDs first (by `title` or `companyName`), and passing `$in` to the `Application.find` query.
- Build a dynamic `sortObj`:
  - `applied_desc`: `{ appliedAt: -1, _id: -1 }` (Application Date Newest)
  - `applied_asc`: `{ appliedAt: 1, _id: 1 }` (Application Date Oldest)
  - `updated_desc`: `{ statusUpdatedAt: -1, _id: -1 }` (Last Updated Date)
  - `match_desc`: `{ matchScore: -1, _id: -1 }` (AI Match Score)

### Step 2: Build the UI Control Bar (`views/candidate/candidate-tracker.ejs`)
Right above the application cards list (around line 57, under the header), introduce a `<form method="GET" action="/candidate/applications">` that mimics the established pattern from `views/extras/internships.ejs`.
- **Search input:** `name="search"`
- **Status select:** `name="status"`
- **Sort select:** `name="sort"`
- Use `onchange="this.form.submit()"` on selects to trigger automatic reloading.
- Preserve the active values using the `searchQuery`, `statusFilter`, and the newly passed `sortOrder` variables.

### Step 3: Ensure Consistent Card Rendering
Because we are passing filtered applications now, the `total` and status counts (in the `stats` object) reflect the entire application pool (via a separate unfiltered query) to ensure the dashboard stats remain accurate, while the `applications` array rendered represents the filtered/sorted result.

## 3. Verification
- Change sort to "Best Match" and verify applications are ordered by `matchScore` descending.
- Change status filter to "Shortlisted" and verify only shortlisted apps show.
- Search for a specific company and verify it works.
- Verify the URL correctly reflects `?sort=match_desc&status=shortlisted`.
