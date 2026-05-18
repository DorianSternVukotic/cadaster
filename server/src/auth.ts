import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from "express";
import { config } from "./config.js";
import { query } from "./db.js";

export interface User {
  id: number;
  email: string;
  display_name: string;
  is_admin: boolean;
}

const COOKIE = "cad_session";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// res.locals.user is populated by attachUser; helpers read it back typed.
export const currentUser = (res: Response): User | null =>
  (res.locals.user as User | undefined) ?? null;

async function createSession(res: Response, userId: number): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
    [token, userId, expires],
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: config.sessionDays * 86400_000,
  });
}

/** Resolve the session cookie to a user on every request (or null). */
export async function attachUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.cookies?.[COOKIE] as string | undefined;
  if (token) {
    const { rows } = await query<User & { expired: boolean }>(
      `SELECT u.id, u.email, u.display_name, u.is_admin,
              s.expires_at < now() AS expired
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = $1`,
      [token],
    );
    const row = rows[0];
    if (row && !row.expired) {
      res.locals.user = {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        is_admin: row.is_admin,
      } satisfies User;
    } else if (row) {
      await query("DELETE FROM sessions WHERE token = $1", [token]);
      res.clearCookie(COOKIE);
    }
  }
  next();
}

export function requireAuth(_req: Request, res: Response, next: NextFunction) {
  if (!currentUser(res))
    return res.status(401).json({ error: "Sign in required." });
  next();
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  const u = currentUser(res);
  if (!u) return res.status(401).json({ error: "Sign in required." });
  if (!u.is_admin)
    return res.status(403).json({ error: "Admin privileges required." });
  next();
}

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const displayName = String(req.body?.displayName ?? "").trim();

  if (!EMAIL_RE.test(email))
    return res.status(400).json({ error: "A valid email is required." });
  if (password.length < 8)
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters." });
  if (displayName.length < 1 || displayName.length > 80)
    return res.status(400).json({ error: "Display name is required." });

  const exists = await query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (exists.rowCount)
    return res.status(409).json({ error: "That email is already registered." });

  // Bootstrap: the first account, or any ADMIN_EMAILS entry, becomes admin.
  const { rows: cnt } = await query<{ n: string }>(
    "SELECT count(*)::int AS n FROM users",
  );
  const isFirst = Number(cnt[0]?.n ?? 0) === 0;
  const isAdmin = isFirst || config.adminEmails.includes(email);

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, display_name, is_admin)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, hash, displayName, isAdmin],
  );
  const id = rows[0]!.id;
  await createSession(res, id);
  res.status(201).json({
    user: { id, email, display_name: displayName, is_admin: isAdmin },
  });
});

authRouter.post("/login", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  const { rows } = await query<User & { password_hash: string }>(
    `SELECT id, email, display_name, is_admin, password_hash
       FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: "Invalid email or password." });

  await query("DELETE FROM sessions WHERE expires_at < now()");
  await createSession(res, user.id);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      is_admin: user.is_admin,
    },
  });
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[COOKIE] as string | undefined;
  if (token) await query("DELETE FROM sessions WHERE token = $1", [token]);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

authRouter.get("/me", (_req, res) => {
  res.json({ user: currentUser(res) });
});
