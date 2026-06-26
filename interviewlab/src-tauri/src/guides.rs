// Interview-guide ("designs") library CRUD (Milestone 10a, feature-roles-and-guides.md §2).
//
// A global, reusable library of guides authored in markdown. Each cycle runs against a
// chosen guide (cycle.guide_id), and a guide's goals are DERIVED from its content_md via
// the EXISTING synthesis::derive_goals — reusing a guide across waves keeps goal_ids
// stable, which is exactly what M9's findings-level diff needs. The derived goals are
// cached in goals_json so reads don't re-parse.
//
// Conventions mirror cycle.rs: a typed struct maps the `guide` table 1:1, all SQL is
// parameterized, each #[tauri::command] is a thin wrapper over a testable `*_db` helper.

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::synthesis::{derive_goals, render_template_md, Goal, GuideTemplate};
use crate::Db;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Internal: the raw `guide` row as stored (goals_json + template_json are JSON strings).
#[derive(FromRow)]
struct GuideRowRaw {
    id: String,
    name: String,
    content_md: String,
    goals_json: String,
    template_json: String,
    created_at: i64,
    updated_at: i64,
}

// A guide returned to the frontend: the row + its parsed (derived) goals + the structured
// `template` (empty for legacy/free-markdown guides). We return parsed `goals` so the UI can
// render "N goals" without re-parsing, and `template` so the structured editor binds to it.
#[derive(Serialize, Clone, Debug)]
pub struct Guide {
    pub id: String,
    pub name: String,
    pub content_md: String,
    pub goals: Vec<Goal>,
    pub template: GuideTemplate,
    pub created_at: i64,
    pub updated_at: i64,
}

// Parse a stored row into the returned Guide. When the guide carries a structured template,
// its goals come from the template's TASKS (the stable spine); otherwise we use the cached
// goals_json, falling back to deriving from content_md so the UI never shows zero goals for a
// guide that actually has them.
fn parse_guide(row: GuideRowRaw) -> Guide {
    let template = GuideTemplate::parse(&row.template_json);
    let goals: Vec<Goal> = if !template.is_empty() {
        template.goals()
    } else {
        let cached: Vec<Goal> = serde_json::from_str(&row.goals_json).unwrap_or_default();
        if cached.is_empty() {
            derive_goals(&row.content_md)
        } else {
            cached
        }
    };
    Guide {
        id: row.id,
        name: row.name,
        content_md: row.content_md,
        goals,
        template,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

// What a write stores for a guide: when a structured `template` is provided, it is the source
// of truth — content_md is RENDERED from it canonically (so derive_goals + chat + back-compat
// keep working) and goals come from its tasks. When no template is provided (raw-markdown
// edit / legacy create), the incoming content_md is stored verbatim and goals are derived
// from it. Pure so it's unit-tested without a DB.
struct GuideWrite {
    content_md: String,
    template: GuideTemplate,
    goals: Vec<Goal>,
}

fn resolve_guide_write(content_md: &str, template: &GuideTemplate) -> GuideWrite {
    let template = template.normalized();
    if !template.is_empty() {
        let goals = template.goals();
        let content_md = render_template_md(&template);
        GuideWrite { content_md, template, goals }
    } else {
        GuideWrite {
            content_md: content_md.to_string(),
            template: GuideTemplate::default(),
            goals: derive_goals(content_md),
        }
    }
}

#[derive(Deserialize)]
pub struct CreateGuide {
    pub name: String,
    #[serde(default)]
    pub content_md: String,
    // The structured template (empty/absent → a free-markdown guide).
    #[serde(default)]
    pub template: GuideTemplate,
}

#[derive(Deserialize)]
pub struct UpdateGuide {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub content_md: String,
    #[serde(default)]
    pub template: GuideTemplate,
}

// --- pool-taking helpers (the real SQL; unit-tested below) --------------------

async fn list_guides_db(pool: &SqlitePool) -> Result<Vec<Guide>, sqlx::Error> {
    let rows = sqlx::query_as::<_, GuideRowRaw>(
        "SELECT id, name, content_md, goals_json, template_json, created_at, updated_at \
         FROM guide ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(parse_guide).collect())
}

async fn get_guide_db(pool: &SqlitePool, id: &str) -> Result<Option<Guide>, sqlx::Error> {
    let row = sqlx::query_as::<_, GuideRowRaw>(
        "SELECT id, name, content_md, goals_json, template_json, created_at, updated_at \
         FROM guide WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(parse_guide))
}

async fn create_guide_db(pool: &SqlitePool, req: &CreateGuide) -> Result<Guide, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let ts = now_ms();
    // A structured template (when present) is the source of truth: content_md is rendered
    // from it, goals come from its tasks. Otherwise the incoming content_md is stored verbatim.
    let w = resolve_guide_write(&req.content_md, &req.template);
    let goals_json = serde_json::to_string(&w.goals).unwrap_or_else(|_| "[]".into());
    let template_json = serde_json::to_string(&w.template).unwrap_or_else(|_| "{}".into());
    sqlx::query(
        "INSERT INTO guide (id, name, content_md, goals_json, template_json, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(req.name.trim())
    .bind(&w.content_md)
    .bind(&goals_json)
    .bind(&template_json)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await?;
    get_guide_db(pool, &id).await.map(|g| g.expect("just inserted"))
}

async fn update_guide_db(pool: &SqlitePool, req: &UpdateGuide) -> Result<Guide, sqlx::Error> {
    // Re-render content_md + re-derive goals + re-stamp template ids from the new content so
    // goals_json/template_json stay the source of truth and ids stay stable across edits.
    let w = resolve_guide_write(&req.content_md, &req.template);
    let goals_json = serde_json::to_string(&w.goals).unwrap_or_else(|_| "[]".into());
    let template_json = serde_json::to_string(&w.template).unwrap_or_else(|_| "{}".into());
    sqlx::query(
        "UPDATE guide SET name = ?, content_md = ?, goals_json = ?, template_json = ?, updated_at = ? \
         WHERE id = ?",
    )
    .bind(req.name.trim())
    .bind(&w.content_md)
    .bind(&goals_json)
    .bind(&template_json)
    .bind(now_ms())
    .bind(&req.id)
    .execute(pool)
    .await?;
    get_guide_db(pool, &req.id).await.map(|g| g.expect("just updated"))
}

// Delete a guide. Cycles that referenced it keep their inline `cycle.guide` text (back-
// compat) but their guide_id is cleared so they fall back cleanly (the FK is nullable).
async fn delete_guide_db(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE cycle SET guide_id = NULL WHERE guide_id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM guide WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// --- Tauri commands (thin wrappers; stringify errors for the frontend) --------

#[tauri::command]
pub async fn list_guides(db: tauri::State<'_, Db>) -> Result<Vec<Guide>, String> {
    list_guides_db(&db.pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_guide(db: tauri::State<'_, Db>, id: String) -> Result<Option<Guide>, String> {
    get_guide_db(&db.pool, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_guide(db: tauri::State<'_, Db>, req: CreateGuide) -> Result<Guide, String> {
    create_guide_db(&db.pool, &req).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_guide(db: tauri::State<'_, Db>, req: UpdateGuide) -> Result<Guide, String> {
    update_guide_db(&db.pool, &req).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_guide(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    delete_guide_db(&db.pool, &id).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // create → derives + caches goals; get/list return them parsed.
    #[tokio::test]
    async fn create_derives_goals_and_roundtrips() {
        let pool = test_pool().await;
        let g = create_guide_db(
            &pool,
            &CreateGuide {
                name: "Activation guide".into(),
                content_md: "Goals:\n- G1: Why do accounts stall?\n- G2: Which step confuses?\n\nTarget conclusions:\n- A ranked list.".into(),
                template: GuideTemplate::default(),
            },
        )
        .await
        .unwrap();
        // Goals derived via synthesis::derive_goals; "Target conclusions" bullet excluded.
        assert_eq!(g.goals.len(), 2);
        assert_eq!(g.goals[0].id, "G1");
        assert_eq!(g.goals[1].id, "G2");

        // goals_json was cached in the row (not just derived on the fly).
        let cached: String = sqlx::query_scalar("SELECT goals_json FROM guide WHERE id = ?")
            .bind(&g.id).fetch_one(&pool).await.unwrap();
        assert!(cached.contains("\"G1\""));

        let listed = list_guides_db(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].goals.len(), 2);
    }

    // update re-derives goals; delete clears any cycle's guide_id (keeps inline text).
    #[tokio::test]
    async fn update_rederives_and_delete_unlinks_cycle() {
        let pool = test_pool().await;
        let g = create_guide_db(&pool, &CreateGuide { name: "G".into(), content_md: "Goals:\n- A".into(), template: GuideTemplate::default() })
            .await.unwrap();
        assert_eq!(g.goals.len(), 1);

        let updated = update_guide_db(&pool, &UpdateGuide {
            id: g.id.clone(),
            name: "G2".into(),
            content_md: "Goals:\n- A\n- B\n- C".into(),
            template: GuideTemplate::default(),
        }).await.unwrap();
        assert_eq!(updated.name, "G2");
        assert_eq!(updated.goals.len(), 3, "goals re-derived on update");

        // Link a cycle to the guide, then delete the guide → cycle.guide_id cleared, inline kept.
        let cycle = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, guide, guide_id, created_at, updated_at) VALUES (?, 'c', 'inline text', ?, ?, ?)")
            .bind(&cycle).bind(&g.id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        delete_guide_db(&pool, &g.id).await.unwrap();
        let (guide_id, inline): (Option<String>, String) =
            sqlx::query_as("SELECT guide_id, guide FROM cycle WHERE id = ?")
                .bind(&cycle).fetch_one(&pool).await.unwrap();
        assert!(guide_id.is_none(), "guide_id cleared on delete");
        assert_eq!(inline, "inline text", "inline guide text preserved for back-compat");
        assert_eq!(list_guides_db(&pool).await.unwrap().len(), 0);
    }

    // The 0002 data-migration: a pre-existing cycle with inline guide text gets a guide
    // row (name "<cycle> — guide", content = the text) + its guide_id set; an empty-guide
    // cycle is left untouched. Participants' role_id backfills from the old enum text.
    #[tokio::test]
    async fn data_migration_maps_guides_and_participant_roles() {
        // Apply 0001 ONLY, seed legacy-shaped data, THEN apply 0002 to exercise the
        // backfill exactly as it runs on the existing dev DB.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        // sqlx::migrate! runs ALL migrations; to test the *0002 backfill over pre-existing
        // rows*, we instead apply 0001 only (via raw_sql, which runs multi-statement SQL),
        // insert legacy-shaped rows, then apply the 0002 SQL file to exercise the backfill
        // exactly as it runs on the existing dev DB.
        let init_sql = include_str!("../migrations/0001_init.sql");
        sqlx::raw_sql(init_sql).execute(&pool).await.unwrap();

        let ts = 1_700_000_000_000i64;
        // Cycle A: has inline guide text → should get a migrated guide + guide_id.
        let cyc_a = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, guide, created_at, updated_at) VALUES (?, 'Wave A', 'Goals:\n- G1: stall', ?, ?)")
            .bind(&cyc_a).bind(ts).bind(ts).execute(&pool).await.unwrap();
        // Cycle B: empty guide → should be left alone.
        let cyc_b = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, guide, created_at, updated_at) VALUES (?, 'Wave B', '', ?, ?)")
            .bind(&cyc_b).bind(ts).bind(ts).execute(&pool).await.unwrap();

        // A legacy interview + participants with the old enum role text (no role_id yet).
        let iv = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'iv', 'new', ?, ?)")
            .bind(&iv).bind(&cyc_a).bind(ts).bind(ts).execute(&pool).await.unwrap();
        for (role, name) in [("interviewer", "R"), ("respondent", "P"), ("bogus-legacy", "X")] {
            sqlx::query("INSERT INTO participant (id, interview_id, display_name, role, speaker_label) VALUES (?, ?, ?, ?, NULL)")
                .bind(Uuid::new_v4().to_string()).bind(&iv).bind(name).bind(role).execute(&pool).await.unwrap();
        }

        // Now apply 0002 (the migration under test) over this legacy state.
        let mig_sql = include_str!("../migrations/0002_roles_guides.sql");
        sqlx::raw_sql(mig_sql).execute(&pool).await.unwrap();

        // Roles seeded.
        let role_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM role").fetch_one(&pool).await.unwrap();
        assert_eq!(role_count, 4);

        // Cycle A got a migrated guide + guide_id; the guide carries the inline text.
        let (a_guide_id,): (Option<String>,) =
            sqlx::query_as("SELECT guide_id FROM cycle WHERE id = ?").bind(&cyc_a).fetch_one(&pool).await.unwrap();
        let a_guide_id = a_guide_id.expect("cycle A linked to a migrated guide");
        let (gname, gcontent): (String, String) =
            sqlx::query_as("SELECT name, content_md FROM guide WHERE id = ?").bind(&a_guide_id).fetch_one(&pool).await.unwrap();
        assert_eq!(gname, "Wave A — guide");
        assert!(gcontent.contains("G1: stall"));

        // Cycle B (empty guide) was left untouched.
        let (b_guide_id,): (Option<String>,) =
            sqlx::query_as("SELECT guide_id FROM cycle WHERE id = ?").bind(&cyc_b).fetch_one(&pool).await.unwrap();
        assert!(b_guide_id.is_none(), "empty-guide cycle gets no guide row");
        let guide_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guide").fetch_one(&pool).await.unwrap();
        assert_eq!(guide_count, 1, "only the non-empty cycle yields a guide");

        // Participant role_id backfilled: known enums map by id; unknown → 'other'.
        let rid_interviewer: String = sqlx::query_scalar("SELECT role_id FROM participant WHERE role = 'interviewer'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(rid_interviewer, "interviewer");
        let rid_respondent: String = sqlx::query_scalar("SELECT role_id FROM participant WHERE role = 'respondent'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(rid_respondent, "respondent");
        let rid_bogus: String = sqlx::query_scalar("SELECT role_id FROM participant WHERE role = 'bogus-legacy'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(rid_bogus, "other", "unrecognized legacy role falls back to 'other'");
        // No participant left without a role_id.
        let unmapped: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM participant WHERE role_id IS NULL")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(unmapped, 0);
    }
}
