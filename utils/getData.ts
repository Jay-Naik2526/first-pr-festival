// @ts-expect-error Node typings are not included in the client-side project.
import fs from "fs";
// @ts-expect-error Node typings are not included in the client-side project.
import path from "path";

/**
 * Shape of a single `spider-society/*.json` file after validation.
 * `fileName` / `dimension` are derived, never authored by contributors.
 */
export type SpiderMember = {
  name: string;
  alias: string;
  skills: string[];
  suitColor: string;
  githubUsername: string;
  /** Source file name, used as a stable React key. */
  fileName: string;
  /** Deterministic "Earth-XXX" label generated from the username. */
  dimension: string;
  /** Hand-written HTML card, rendered in a sandboxed iframe. */
  html?: string;
};

/** Reads one data-* attribute off the card's root element. */
function attr(html: string, name: string): string {
  const m = html.match(new RegExp(`data-${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1].trim() : "";
}

/**
 * Student HTML is rendered inside a sandboxed iframe (no scripts, no
 * same-origin), so it cannot touch the host page. We still strip script and
 * event handlers here as a second layer — defence in depth, and it keeps
 * anything obviously hostile out of the built output entirely.
 */
function sanitizeCardHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

const SOCIETY_DIR = path.join(process.cwd(), "spider-society");
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FALLBACK_COLOR = "#E62429";

/** Stable hash so a member always lands in the same dimension across builds. */
function dimensionFor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  }
  return `EARTH-${String(hash % 100000).padStart(5, "0")}`;
}

function sanitize(raw: unknown, fileName: string): SpiderMember | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;

  const name = typeof data.name === "string" ? data.name.trim() : "";
  const alias = typeof data.alias === "string" ? data.alias.trim() : "";
  const githubUsername =
    typeof data.githubUsername === "string"
      ? data.githubUsername.trim().replace(/^@/, "")
      : "";

  // A card is meaningless without these three — skip the entry instead of
  // breaking the whole build for everyone else.
  if (!name || !alias || !githubUsername) return null;

  const skills = Array.isArray(data.skills)
    ? data.skills
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];

  const suitColor =
    typeof data.suitColor === "string" && HEX.test(data.suitColor.trim())
      ? data.suitColor.trim()
      : FALLBACK_COLOR;

  return {
    name,
    alias,
    skills,
    suitColor,
    githubUsername,
    fileName,
    dimension: dimensionFor(githubUsername),
  };
}

/**
 * Reads every `.json` file in `/spider-society` (ignoring `_template.json`
 * and any other underscore-prefixed file) and returns the parsed roster.
 *
 * Runs at build time on the server only — no database, no API calls.
 */
export function getSpiderSociety(): SpiderMember[] {
  if (!fs.existsSync(SOCIETY_DIR)) return [];

  const entries = fs.readdirSync(SOCIETY_DIR).filter((file) => !file.startsWith("_"));
  const files = entries.filter((file) => file.endsWith(".json"));
  const htmlFiles = entries.filter((file) => file.endsWith(".html"));

  const members: SpiderMember[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    try {
      const contents = fs.readFileSync(path.join(SOCIETY_DIR, file), "utf-8");
      const member = sanitize(JSON.parse(contents), file);
      if (!member) {
        console.warn(`[spider-society] Skipped ${file}: missing required fields.`);
        continue;
      }
      const key = member.githubUsername.toLowerCase();
      if (seen.has(key)) {
        console.warn(`[spider-society] Skipped ${file}: duplicate @${key}.`);
        continue;
      }
      seen.add(key);
      members.push(member);
    } catch (error) {
      // One malformed PR should never take the live roster down.
      console.warn(`[spider-society] Skipped ${file}: invalid JSON.`, error);
    }
  }

  // Hand-woven HTML cards. These take precedence over a JSON entry for the
  // same person — the suit they built beats the one we generated.
  for (const file of htmlFiles) {
    try {
      const raw = fs.readFileSync(path.join(SOCIETY_DIR, file), "utf-8");
      const githubUsername = (attr(raw, "github") || file.replace(/\.html$/i, "")).replace(/^@/, "");
      const name = attr(raw, "name");
      const alias = attr(raw, "alias");
      if (!githubUsername || !name || !alias) {
        console.warn(`[spider-society] Skipped ${file}: missing data- attributes.`);
        continue;
      }
      const suit = attr(raw, "suit");
      const key = githubUsername.toLowerCase();
      // A paired .json is read first in the loop above — inherit its skills
      // (and its suitColor, unless the card set its own) so a hand-woven
      // card still contributes to "Unique Abilities" / "Top Ability" on the
      // hero stats bar instead of always reporting an empty skill set.
      const existing = members.findIndex((m) => m.githubUsername.toLowerCase() === key);
      const paired = existing >= 0 ? members[existing] : null;
      const member: SpiderMember = {
        name,
        alias,
        skills: paired?.skills ?? [],
        suitColor: HEX.test(suit) ? suit : paired?.suitColor ?? FALLBACK_COLOR,
        githubUsername,
        fileName: file,
        dimension: dimensionFor(githubUsername),
        html: sanitizeCardHtml(raw),
      };
      if (existing >= 0) members[existing] = member;
      else members.push(member);
      seen.add(key);
    } catch (error) {
      console.warn(`[spider-society] Skipped ${file}: unreadable.`, error);
    }
  }

  return members.sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Convenience aggregate for the hero stats bar. */
export function getSocietyStats(members: SpiderMember[]) {
  const skills = members.flatMap((m) => m.skills.map((s) => s.toLowerCase()));
  const topSkill =
    Object.entries(
      skills.reduce<Record<string, number>>((acc, skill) => {
        acc[skill] = (acc[skill] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";

  return {
    anomaliesMerged: members.length,
    // "Dimensions Linked" used to be near-identical to anomaliesMerged
    // (dimension is a hash of the username, so it's ~1:1 with headcount).
    // Hand-woven count is genuinely different information, and it's a fun
    // one to watch climb during Act I as students discover the HTML card.
    handWoven: members.filter((m) => Boolean(m.html)).length,
    uniqueSkills: new Set(skills).size,
    topSkill,
  };
}

export default getSpiderSociety;
