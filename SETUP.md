# Opportunity Navigator: setup (about 20 minutes, no coding)

## How it works
- **Approvers (max 6)** log in and add people on the **Members** page: one at a time, or hundreds at once from a spreadsheet.
- Each person added by an approver is told by email that they have access.
- **Logging in starts with the email only.** If it is not in the database, the person is told to contact an approver. If it is their **first time**, we email a link to create their password; after creating it they log in with email + password. If they already have a password, they are asked for it.
- **Forgot password:** people can change their own password **once every 2 months** (the page says so). If it is urgent, an approver clicks **Send password link** next to their name on the Members page, which works at any time.
- Approvers can switch on **Email code at log-in** (top of the Members page). When on, everyone must also enter a 6-digit code we email them at each log-in. It is off by default.
- Anyone who has not set a password yet, or forgets it, clicks **First time here, or forgot your password?** on the log-in page and gets a fresh link.
- **Teachers** add opportunities. **Heads of department** approve them before students see them.
- Everything lives in an online database, so any device sees the same data.

## Step 1: Database (you already have one)
Your Supabase project works. Supabase > Project Settings > Database > copy the **URI** connection string. That is `DATABASE_URL`.
No tables to create: the app builds them itself on first start.

## Step 2: Email (so password links and sign-in codes can be sent)
Render's free plan blocks Gmail and other SMTP email, so we use a web email service. **SMTP2GO** is recommended (free: 1,000 emails a month, 200 a day).
1. Sign up at smtp2go.com (no credit card).
2. **Sending > Verified Senders > Single sender emails** > add an address you can open. SMTP2GO emails it a link; click it.
3. **Sending > API Keys** > Add API Key. Copy it (shown once).
4. In Render > Environment add `SMTP2GO_API_KEY` (the key) and `EMAIL_FROM` (the address you verified). Remove `BREVO_API_KEY` and any `SMTP_*` lines.
Until a whole domain is verified, SMTP2GO sends at most 25 emails an hour; extra emails wait in a queue and go out the next hour. That is fine for logins; for a big import it means the password-link emails arrive over a few hours.
**Brevo** also still works: set `BREVO_API_KEY` instead (only used if `SMTP2GO_API_KEY` is empty).
**Never** import fake or sample addresses with "Let them log in now" ticked: emails to addresses that do not exist bounce and can get an account suspended.

## Step 3: Put the code on GitHub
Create a free GitHub account > New repository (private) > upload every file from this folder (`.env.example` is safe; there is no real `.env`).

## Step 4: Publish on Render
1. render.com > New > **Web Service** > connect your GitHub repository.
2. Build command: `pip install -r requirements.txt`
3. Start command: `gunicorn app:app --timeout 120`
4. Under **Environment**, add every line from `.env.example` with your real values.
   Also add `PYTHON_VERSION` = `3.12.3`.
5. Deploy. Render gives you an address like `https://something.onrender.com`. Put it in `APP_URL`, save, and it redeploys.

## Step 5: First login
Open your site and log in with `FIRST_ADMIN_EMAIL` and `FIRST_ADMIN_PASSWORD`.
Go to **Members**:
1. Add your other approvers (up to 6 in total) (role: Approver).
2. Add heads of department (role: Head of department) and teachers.
3. Import all students with the CSV or paste box. Download the template there to see the format.
Once the first admin exists you can delete the `FIRST_ADMIN_PASSWORD` line from Render.

## Good to know
- Free Render sites sleep after inactivity; the first visit can take about 30 seconds.
- **Remove access** locks someone out immediately. **Send password link** emails them a link to choose a new password.
- Password links from an approver work once and expire after 7 days; links people request themselves expire after 2 hours.
- People who have added opportunities cannot be deleted (remove their access instead).
- Roles in the CSV: `student`, `teacher`, `hod`, `staff`, `admin` (admin = approver).
- 8 wrong passwords in a row lock that email for 15 minutes.
- If email is not set up, codes and password links are printed in Render's **Logs** tab, handy for testing.
- If sending fails, the exact reason is printed in the **Logs** tab (look for `EMAIL FAILED`).
