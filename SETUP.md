# Opportunity Navigator: setup (about 20 minutes, no coding)

## How it works
- **Approvers (max 3)** log in and add people on the **Members** page: one at a time, or hundreds at once from a spreadsheet.
- Each person added gets an email with their password. They log in with their email + that password, then we email a 6-digit code / link to confirm it is really them.
- **Teachers** add opportunities. **Heads of department** approve them before students see them.
- Everything lives in an online database, so any device sees the same data.

## Step 1: Database (you already have one)
Your Supabase project works. Supabase > Project Settings > Database > copy the **URI** connection string. That is `DATABASE_URL`.
No tables to create: the app builds them itself on first start.

## Step 2: Email (so codes and passwords can be sent)
Easiest: a Gmail account.
1. Google Account > Security > turn on 2-Step Verification.
2. Google Account > Security > search "App passwords" > create one called "Navigator".
3. Use that 16-letter code as `SMTP_PASSWORD`, and the Gmail address as `SMTP_USER` / `SMTP_FROM`.
Gmail allows about 500 emails a day, which is plenty for a school. If emails land in spam, ask people to mark them "not spam".

## Step 3: Put the code on GitHub
Create a free GitHub account > New repository (private) > upload every file from this folder (`.env.example` is safe; there is no real `.env`).

## Step 4: Publish on Render
1. render.com > New > **Web Service** > connect your GitHub repository.
2. Build command: `pip install -r requirements.txt`
3. Start command: `gunicorn app:app`
4. Under **Environment**, add every line from `.env.example` with your real values.
   Also add `PYTHON_VERSION` = `3.12.3`.
5. Deploy. Render gives you an address like `https://something.onrender.com`. Put it in `APP_URL`, save, and it redeploys.

## Step 5: First login
Open your site and log in with `FIRST_ADMIN_EMAIL` and `FIRST_ADMIN_PASSWORD`. A code arrives by email; enter it.
Go to **Members**:
1. Add your 2 other approvers (role: Approver).
2. Add heads of department (role: Head of department) and teachers.
3. Import all students with the CSV or paste box. Download the template there to see the format.
Once the first admin exists you can delete the `FIRST_ADMIN_PASSWORD` line from Render.

## Good to know
- Free Render sites sleep after inactivity; the first visit can take about 30 seconds.
- **Remove access** locks someone out immediately. **New password** emails them a fresh one.
- People who have added opportunities cannot be deleted (remove their access instead).
- Roles in the CSV: `student`, `teacher`, `hod`, `staff`, `admin` (admin = approver).
- If email is not set up, codes and passwords are printed in Render's **Logs** tab, handy for testing.
