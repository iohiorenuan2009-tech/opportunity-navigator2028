"""Opportunity Navigator backend (Flask + SQLAlchemy).
Local: SQLite file. Online: set DATABASE_URL to a hosted Postgres URL."""
import os, re, secrets, hashlib, smtplib, threading, datetime as dt
from email.message import EmailMessage
from functools import wraps

from flask import Flask, request, session, jsonify
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(BASE, 'static'), static_url_path='')
app.config.update(
    SECRET_KEY=os.environ.get('SECRET_KEY', 'dev-only-change-me'),
    SQLALCHEMY_DATABASE_URI=(os.environ.get('DATABASE_URL') or 'sqlite:///' + os.path.join(BASE, 'navigator.db'))
        .replace('postgres://', 'postgresql://', 1),
    SQLALCHEMY_ENGINE_OPTIONS={'pool_pre_ping': True},
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=os.environ.get('HTTPS_ONLY') == '1',
    PERMANENT_SESSION_LIFETIME=dt.timedelta(minutes=30),   # idle logout after 30 minutes
)
if os.environ.get('HTTPS_ONLY') == '1' and not os.environ.get('SECRET_KEY'):
    raise RuntimeError('SECRET_KEY is not set. Add it in your hosting settings (see SETUP.md).')
db = SQLAlchemy(app)
APP_URL = os.environ.get('APP_URL', 'http://localhost:5000')

ROLES = ('student', 'staff', 'teacher', 'hod', 'admin')
ADDERS = ('teacher', 'hod', 'admin')     # may create opportunities
REVIEWERS = ('hod', 'admin')             # may approve; their own posts go live at once
FIELDS = ['STEM', 'Business', 'Arts', 'Humanities', 'Social Impact', 'Leadership']
TYPES = ['Competition', 'Research programme', 'Conference', 'Scholarship', 'Programme']
AIDS = ['Need blind', 'Need aware', 'Full aid', 'Partial aid', 'No aid']
TEXT_FIELDS = ['title', 'provider', 'description', 'field', 'aid', 'type', 'deadline',
               'location', 'eligibility', 'link']
NUM_FIELDS = ['age_min', 'age_max', 'duration_weeks']
MAX_ADMINS = 3                           # only 3 approvers (admins) may exist
DEFAULT_GROUP = {'student': 'Students', 'teacher': 'Teachers', 'hod': 'Heads of Department',
                 'staff': 'Staff', 'admin': 'Approvers'}
ROLE_ALIASES = {'approver': 'admin', 'head': 'hod', 'head of department': 'hod', 'department head': 'hod',
                'students': 'student', 'teachers': 'teacher'}
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
OTP_MINUTES = 10
OTP_MAX_TRIES = 5


def now():
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def h(text):
    return hashlib.sha256(str(text).encode()).hexdigest()


# ---------- MODELS ----------
class Member(db.Model):
    """Every ALA student, teacher, staff member and admin. Loaded by the admin, never self-registered."""
    id = db.Column(db.Integer, primary_key=True)
    first_name = db.Column(db.String(60), nullable=False)
    last_name = db.Column(db.String(60), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(10), nullable=False)
    group_name = db.Column(db.String(60), nullable=False)      # e.g. "Year 1", "Teachers"
    on_platform = db.Column(db.Boolean, nullable=False, default=False)

    @property
    def full_name(self):
        return f'{self.first_name} {self.last_name}'


class LoginCode(db.Model):
    """One pending sign-in: a 6-digit code and a link token, both stored only as hashes."""
    id = db.Column(db.Integer, primary_key=True)
    member_id = db.Column(db.Integer, db.ForeignKey('member.id'), nullable=False)
    code_hash = db.Column(db.String(64), nullable=False)
    token_hash = db.Column(db.String(64), nullable=False)
    expires_at = db.Column(db.DateTime, nullable=False)
    tries = db.Column(db.Integer, nullable=False, default=0)


class Opportunity(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(120), nullable=False)
    provider = db.Column(db.String(160), nullable=False)
    description = db.Column(db.Text, nullable=False)
    field = db.Column(db.String(30), nullable=False)
    aid = db.Column(db.String(30), nullable=False)
    type = db.Column(db.String(30), nullable=False)
    deadline = db.Column(db.String(10), nullable=False)
    age_min = db.Column(db.Integer, nullable=False)
    age_max = db.Column(db.Integer, nullable=False)
    duration_weeks = db.Column(db.Integer, nullable=False)
    location = db.Column(db.String(120), nullable=False)
    eligibility = db.Column(db.String(300), nullable=False)
    link = db.Column(db.String(300), nullable=False)
    status = db.Column(db.String(10), nullable=False, default='pending')   # pending | published | rejected
    created_by = db.Column(db.Integer, db.ForeignKey('member.id'), nullable=False)
    creator = db.relationship('Member')

    def to_dict(self):
        return {'id': self.id, 'title': self.title, 'provider': self.provider, 'description': self.description,
                'field': self.field, 'aid': self.aid, 'type': self.type, 'deadline': self.deadline,
                'age_min': self.age_min, 'age_max': self.age_max, 'duration_weeks': self.duration_weeks,
                'location': self.location, 'eligibility': self.eligibility, 'link': self.link,
                'status': self.status, 'created_by': self.created_by,
                'created_by_name': self.creator.full_name}


class Saved(db.Model):
    """Wishlist. Only the student who owns a row can read it."""
    member_id = db.Column(db.Integer, db.ForeignKey('member.id'), primary_key=True)
    opportunity_id = db.Column(db.Integer, db.ForeignKey('opportunity.id'), primary_key=True)


# ---------- HELPERS ----------
def err(msg, code=400):
    return jsonify(error=msg), code


def member_json(m):
    return {'id': m.id, 'name': m.full_name, 'first_name': m.first_name, 'role': m.role,
            'group': m.group_name, 'email': m.email}


def current_member():
    mid = session.get('member_id')
    m = db.session.get(Member, mid) if mid else None
    return m if m and m.on_platform else None   # switched off by admin = logged out


def login_required(*roles):
    def deco(f):
        @wraps(f)
        def inner(*a, **kw):
            m = current_member()
            if m is None:
                return err('Please log in again.', 401)
            if roles and m.role not in roles:
                return err('You do not have permission to do that.', 403)
            return f(m, *a, **kw)
        return inner
    return deco


def send_email(to, subject, body):
    host = os.environ.get('SMTP_HOST')
    if not host:   # no mail server configured yet: print the email so you can test locally
        print(f'\n--- EMAIL to {to}: {subject}\n{body}\n---\n')
        return
    msg = EmailMessage()
    msg['Subject'], msg['From'], msg['To'] = subject, os.environ['SMTP_FROM'], to
    msg.set_content(body)
    with smtplib.SMTP(host, int(os.environ.get('SMTP_PORT', 587)), timeout=20) as s:
        s.starttls()
        s.login(os.environ['SMTP_USER'], os.environ['SMTP_PASSWORD'])
        s.send_message(msg)


def send_later(messages):
    """Send many emails in the background so the page does not wait. messages = [(to, subject, body)]."""
    def run():
        for to, subject, body in messages:
            try:
                send_email(to, subject, body)
            except Exception as e:
                print('EMAIL FAILED for', to, '-', e)
    if messages:
        threading.Thread(target=run, daemon=True).start()


def new_password():
    return ''.join(secrets.choice('abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(10))


def grant_access(m, queue):
    """Switch a member on, give them a fresh random password and queue the welcome email."""
    pw = new_password()
    m.password_hash = generate_password_hash(pw)
    m.on_platform = True
    queue.append((m.email, 'You have been added to Opportunity Navigator',
                  f'Hi {m.first_name},\n\nYou now have access to Opportunity Navigator.\n\n'
                  f'Open: {APP_URL}\nEmail: {m.email}\nPassword: {pw}\n\n'
                  'After you enter these, we email you a 6-digit code (or a link) to confirm it is you.'))


def clean_opp(d):
    v = {k: str(d.get(k) or '').strip() for k in TEXT_FIELDS + NUM_FIELDS}
    errs = [f'{k.replace("_", " ").capitalize()} is required.' for k in TEXT_FIELDS + NUM_FIELDS if not v[k]]
    if not errs:
        if not all(v[k].isdigit() for k in NUM_FIELDS):
            errs.append('Ages and duration must be whole numbers.')
        else:
            for k in NUM_FIELDS:
                v[k] = int(v[k])
            if v['age_min'] > v['age_max']:
                errs.append('Minimum age cannot be above maximum age.')
        if v['field'] not in FIELDS: errs.append('Choose a valid field.')
        if v['type'] not in TYPES: errs.append('Choose a valid type.')
        if v['aid'] not in AIDS: errs.append('Choose a valid financial aid option.')
        try:
            dt.date.fromisoformat(v['deadline'])
        except ValueError:
            errs.append('Deadline must be a valid date.')
        if not v['link'].startswith(('http://', 'https://')):
            errs.append('Application link must start with http:// or https://.')
    return (v, []) if not errs else (None, errs)


def can_edit(m, o):
    return m.role in REVIEWERS or (o.created_by == m.id and o.status in ('pending', 'rejected'))


# ---------- LOGIN: password, then emailed code or link ----------
@app.post('/api/login')
def login():
    d = request.get_json(silent=True) or {}
    m = Member.query.filter_by(email=str(d.get('email', '')).strip().lower()).first()
    if not m or not check_password_hash(m.password_hash, d.get('password', '')):
        return err('Email or password is incorrect.', 401)
    if not m.on_platform:
        return err('Your account is not active on the platform. Please contact the administrator.', 403)
    code, token = f'{secrets.randbelow(10**6):06d}', secrets.token_urlsafe(24)
    LoginCode.query.filter_by(member_id=m.id).delete()
    db.session.add(LoginCode(member_id=m.id, code_hash=h(code), token_hash=h(token),
                             expires_at=now() + dt.timedelta(minutes=OTP_MINUTES)))
    db.session.commit()
    try:
        send_email(m.email, 'Your Opportunity Navigator sign-in',
                   f'Hi {m.first_name},\n\nYour sign-in code is {code}\n\n'
                   f'Or open this link: {APP_URL}/#/verify?token={token}\n\n'
                   f'Both expire in {OTP_MINUTES} minutes. If this was not you, ignore this email.')
    except Exception as e:
        print('LOGIN EMAIL FAILED:', e)
        return err('We could not send your sign-in email. Please try again or contact an approver.', 500)
    return jsonify(ok=True)


@app.post('/api/verify')
def verify():
    d = request.get_json(silent=True) or {}
    if d.get('token'):
        lc = LoginCode.query.filter_by(token_hash=h(d['token'])).first()
        ok = lc is not None
    else:
        m = Member.query.filter_by(email=str(d.get('email', '')).strip().lower()).first()
        lc = LoginCode.query.filter_by(member_id=m.id).first() if m else None
        ok = lc is not None and secrets.compare_digest(h(str(d.get('code', '')).strip()), lc.code_hash)
    if lc is None or lc.expires_at < now():
        return err('That code or link is invalid or has expired. Please log in again.', 400)
    if not ok:
        lc.tries += 1
        if lc.tries >= OTP_MAX_TRIES:
            db.session.delete(lc)
        db.session.commit()
        return err('That code is not correct.', 400)
    m = db.session.get(Member, lc.member_id)
    db.session.delete(lc)
    db.session.commit()
    if not m.on_platform:
        return err('Your account is not active on the platform.', 403)
    session.clear()
    session.permanent = True
    session['member_id'] = m.id
    return jsonify(user=member_json(m))


@app.post('/api/logout')
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get('/api/me')
@login_required()
def me(m):
    return jsonify(user=member_json(m))


@app.get('/api/meta')
def meta():
    return jsonify(fields=FIELDS, types=TYPES, aids=AIDS, roles=ROLES)


# ---------- OPPORTUNITIES ----------
@app.get('/api/opportunities')
@login_required()
def list_published(m):
    rows = Opportunity.query.filter_by(status='published').order_by(Opportunity.deadline).all()
    return jsonify([o.to_dict() for o in rows])


@app.get('/api/opportunities/manage')
@login_required(*ADDERS)
def list_manage(m):
    q = Opportunity.query.order_by(Opportunity.status, Opportunity.deadline)
    if m.role == 'teacher':
        q = q.filter_by(created_by=m.id)          # teachers see only their own submissions
    return jsonify([o.to_dict() for o in q.all()])


@app.get('/api/opportunities/<int:oid>')
@login_required()
def get_opp(m, oid):
    o = db.session.get(Opportunity, oid)
    if not o or not (o.status == 'published' or m.role in REVIEWERS or o.created_by == m.id):
        return err('We could not find that opportunity.', 404)
    return jsonify(o.to_dict())


@app.post('/api/opportunities')
@login_required(*ADDERS)
def create_opp(m):
    v, errs = clean_opp(request.get_json(silent=True) or {})
    if errs:
        return jsonify(error=' '.join(errs), errors=errs), 400
    o = Opportunity(**v, created_by=m.id, status='published' if m.role in REVIEWERS else 'pending')
    db.session.add(o)
    db.session.commit()
    return jsonify(o.to_dict()), 201


@app.put('/api/opportunities/<int:oid>')
@login_required(*ADDERS)
def update_opp(m, oid):
    o = db.session.get(Opportunity, oid)
    if not o or not can_edit(m, o):
        return err('You cannot edit this opportunity.', 403)
    v, errs = clean_opp(request.get_json(silent=True) or {})
    if errs:
        return jsonify(error=' '.join(errs), errors=errs), 400
    for k, val in v.items():
        setattr(o, k, val)
    if m.role == 'teacher':
        o.status = 'pending'                      # any change goes back to the head of department
    db.session.commit()
    return jsonify(o.to_dict())


@app.delete('/api/opportunities/<int:oid>')
@login_required(*ADDERS)
def delete_opp(m, oid):
    o = db.session.get(Opportunity, oid)
    if not o or not can_edit(m, o):
        return err('You cannot delete this opportunity.', 403)
    Saved.query.filter_by(opportunity_id=oid).delete()
    db.session.delete(o)
    db.session.commit()
    return jsonify(ok=True)


@app.post('/api/opportunities/<int:oid>/review')
@login_required(*REVIEWERS)
def review_opp(m, oid):
    o = db.session.get(Opportunity, oid)
    action = (request.get_json(silent=True) or {}).get('action')
    if not o or action not in ('approve', 'reject'):
        return err('Nothing to review.', 404)
    o.status = 'published' if action == 'approve' else 'rejected'
    db.session.commit()
    return jsonify(o.to_dict())


# ---------- WISHLIST (students only) ----------
@app.get('/api/saved')
@login_required('student')
def list_saved(m):
    rows = (db.session.query(Opportunity).join(Saved, Saved.opportunity_id == Opportunity.id)
            .filter(Saved.member_id == m.id, Opportunity.status == 'published')
            .order_by(Opportunity.deadline).all())
    return jsonify([o.to_dict() for o in rows])


@app.route('/api/saved/<int:oid>', methods=['PUT', 'DELETE'])
@login_required('student')
def toggle_saved(m, oid):
    row = db.session.get(Saved, (m.id, oid))
    if request.method == 'PUT' and not row:
        o = db.session.get(Opportunity, oid)
        if o and o.status == 'published':
            db.session.add(Saved(member_id=m.id, opportunity_id=oid))
    elif request.method == 'DELETE' and row:
        db.session.delete(row)
    db.session.commit()
    return jsonify(ok=True)


# ---------- APPROVERS (admins): members and platform access ----------
def admin_count():
    return Member.query.filter_by(role='admin').count()


def add_members(rows, give_access):
    """Create members from a list of dicts. Returns (added, skipped). Nobody can self-register."""
    added, skipped, queue, seen = 0, [], [], set()
    admins = admin_count()
    for i, r in enumerate(rows, 1):
        first, last = str(r.get('first_name') or '').strip(), str(r.get('last_name') or '').strip()
        if not first and r.get('name'):
            first, _, last = str(r['name']).strip().partition(' ')
            last = last.strip()
        email = str(r.get('email') or '').strip().lower()
        role = str(r.get('role') or 'student').strip().lower()
        role = ROLE_ALIASES.get(role, role)
        label = email or f'row {i}'
        if not first or not last:
            skipped.append(f'{label}: needs a first and last name'); continue
        if not EMAIL_RE.match(email):
            skipped.append(f'{label}: not a valid email'); continue
        if role not in ROLES:
            skipped.append(f'{label}: unknown role "{role}"'); continue
        if email in seen or Member.query.filter_by(email=email).first():
            skipped.append(f'{label}: already exists'); continue
        if role == 'admin' and admins >= MAX_ADMINS:
            skipped.append(f'{label}: there can only be {MAX_ADMINS} approvers'); continue
        seen.add(email)
        if role == 'admin':
            admins += 1
        m = Member(first_name=first[:60], last_name=last[:60], email=email, role=role,
                   group_name=(str(r.get('group') or '').strip() or DEFAULT_GROUP[role])[:60],
                   password_hash=generate_password_hash(new_password()), on_platform=False)
        db.session.add(m)
        if give_access:
            grant_access(m, queue)
        added += 1
    db.session.commit()
    send_later(queue)
    return added, skipped


@app.get('/api/admin/members')
@login_required('admin')
def admin_members(m):
    rows = Member.query.order_by(Member.group_name, Member.last_name).all()
    return jsonify([member_json(x) | {'on_platform': x.on_platform, 'last_name': x.last_name} for x in rows])


@app.get('/api/admin/groups')
@login_required('admin')
def admin_groups(m):
    rows = (db.session.query(Member.role, Member.group_name, db.func.count(Member.id))
            .group_by(Member.role, Member.group_name).all())
    return jsonify([{'role': r, 'group': g, 'count': c} for r, g, c in rows])


@app.post('/api/admin/members')
@login_required('admin')
def admin_add_one(m):
    d = request.get_json(silent=True) or {}
    added, skipped = add_members([d], bool(d.get('give_access', True)))
    if skipped:
        return err(skipped[0].split(': ', 1)[-1].capitalize() + '.')
    return jsonify(added=added), 201


@app.post('/api/admin/members/import')
@login_required('admin')
def admin_import(m):
    d = request.get_json(silent=True) or {}
    rows = d.get('rows') or []
    if not isinstance(rows, list) or not rows:
        return err('No people found to import.')
    if len(rows) > 2000:
        return err('Please import at most 2000 people at a time.')
    added, skipped = add_members(rows, bool(d.get('give_access', True)))
    return jsonify(added=added, skipped=skipped)


@app.put('/api/admin/members/<int:mid>')
@login_required('admin')
def admin_edit(m, mid):
    x = db.session.get(Member, mid)
    d = request.get_json(silent=True) or {}
    if not x:
        return err('Member not found.', 404)
    role = ROLE_ALIASES.get(str(d.get('role', x.role)).lower(), str(d.get('role', x.role)).lower())
    email = str(d.get('email', x.email)).strip().lower()
    first, last = str(d.get('first_name', '')).strip(), str(d.get('last_name', '')).strip()
    if not first or not last:
        return err('First and last name are required.')
    if role not in ROLES or not EMAIL_RE.match(email):
        return err('Check the role and email.')
    if email != x.email and Member.query.filter_by(email=email).first():
        return err('Another member already uses that email.')
    if role == 'admin' and x.role != 'admin' and admin_count() >= MAX_ADMINS:
        return err(f'There can only be {MAX_ADMINS} approvers.')
    if x.id == m.id and role != 'admin':
        return err('You cannot remove your own approver role.')
    x.first_name, x.last_name, x.email, x.role = first[:60], last[:60], email, role
    x.group_name = (str(d.get('group') or '').strip() or DEFAULT_GROUP[role])[:60]
    db.session.commit()
    return jsonify(ok=True)


@app.delete('/api/admin/members/<int:mid>')
@login_required('admin')
def admin_delete(m, mid):
    x = db.session.get(Member, mid)
    if not x:
        return err('Member not found.', 404)
    if x.id == m.id:
        return err('You cannot delete yourself.')
    if Opportunity.query.filter_by(created_by=x.id).first():
        return err('This person has added opportunities, so they cannot be deleted. Remove their access instead.')
    Saved.query.filter_by(member_id=x.id).delete()
    LoginCode.query.filter_by(member_id=x.id).delete()
    db.session.delete(x)
    db.session.commit()
    return jsonify(ok=True)


@app.post('/api/admin/members/<int:mid>/reset-password')
@login_required('admin')
def admin_reset(m, mid):
    x = db.session.get(Member, mid)
    if not x or not x.on_platform:
        return err('Only members with access can have their password reset.')
    queue = []
    grant_access(x, queue)
    db.session.commit()
    send_later(queue)
    return jsonify(ok=True)


@app.post('/api/admin/members/platform')
@login_required('admin')
def admin_platform(m):
    """Switch members on or off the platform. scope: all | role | group | member.
    Switching ON emails each newly added person a fresh password."""
    d = request.get_json(silent=True) or {}
    on, scope, value = bool(d.get('on')), d.get('scope'), d.get('value')
    q = Member.query
    if scope == 'role':
        q = q.filter_by(role=value)
    elif scope == 'group':
        q = q.filter_by(group_name=value)
    elif scope == 'member':
        q = q.filter_by(id=int(value))
    elif scope != 'all':
        return err('Unknown selection.')
    changed, queue = 0, []
    for x in q.all():
        if x.id == m.id and not on:
            continue                              # an approver cannot lock themselves out
        if on and not x.on_platform:
            grant_access(x, queue)
            changed += 1
        elif not on and x.on_platform:
            x.on_platform = False
            changed += 1
    db.session.commit()
    send_later(queue)
    return jsonify(changed=changed)


@app.get('/')
def index():
    return app.send_static_file('index.html')


def bootstrap_first_admin():
    """Creates the very first approver from settings, so you never need a terminal on the host."""
    email = os.environ.get('FIRST_ADMIN_EMAIL', '').strip().lower()
    pw = os.environ.get('FIRST_ADMIN_PASSWORD', '')
    if not email or not pw or Member.query.filter_by(email=email).first() or admin_count() >= MAX_ADMINS:
        return
    first, _, last = os.environ.get('FIRST_ADMIN_NAME', 'First Approver').strip().partition(' ')
    db.session.add(Member(first_name=first, last_name=last or 'Approver', email=email, role='admin',
                          group_name='Approvers', password_hash=generate_password_hash(pw), on_platform=True))
    db.session.commit()


with app.app_context():
    db.create_all()
    bootstrap_first_admin()

if __name__ == '__main__':
    app.run(debug=True)
