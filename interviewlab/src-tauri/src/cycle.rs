// Cycle CRUD commands (Milestone 2). Typed structs mirror the `cycle` table in
// migrations/0001_init.sql exactly; all SQL is parameterized.
//
// Each #[tauri::command] is a thin wrapper over a pool-taking helper (`*_db`) so the
// SQL is unit-testable against a real sqlx SQLite pool without the Tauri runtime.
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::Db;

// A full cycle row — field names/types match the `cycle` table 1:1.
// prev_cycle_id is nullable in the schema (Option), the rest are NOT NULL.
// guide_id (M10a) links the cycle to a library guide; nullable (cycles keep their inline
// `guide` text for back-compat, and synthesis prefers the linked guide when set).
#[derive(Serialize, FromRow)]
pub struct Cycle {
    pub id: String,
    pub name: String,
    pub product_desc: String,
    // product_id (Products library) links the cycle to a library product; nullable (cycles
    // keep their inline `product_desc` text for back-compat, and the pipeline prefers the
    // linked product's content when set). Mirrors guide_id.
    pub product_id: Option<String>,
    pub guide: String,
    pub guide_id: Option<String>,
    pub prev_cycle_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

// Create only needs a name (spec §3.1: "New Cycle → Dialog asks for name").
// product_desc/guide/prev_cycle_id are filled in later on the Overview tab.
#[derive(Deserialize)]
pub struct CreateCycle {
    pub name: String,
}

// Update carries the editable Overview fields. id selects the row; the rest overwrite.
#[derive(Deserialize)]
pub struct UpdateCycle {
    pub id: String,
    pub name: String,
    pub product_desc: String,
    // The Overview's product picker writes the linked library product here. Empty/None = no
    // linked product (the pipeline falls back to the inline `product_desc` text). Normalized
    // to NULL below alongside guide_id/prev_cycle_id.
    #[serde(default)]
    pub product_id: Option<String>,
    pub guide: String,
    // M10a: the Overview's guide picker writes the linked library guide here. Empty/None
    // = no linked guide (synthesis falls back to the inline `guide` text). Normalized to
    // NULL below alongside prev_cycle_id.
    #[serde(default)]
    pub guide_id: Option<String>,
    // ponytail: empty string from the UI's "none" Select is normalized to NULL below.
    pub prev_cycle_id: Option<String>,
}

fn now_ms() -> i64 {
    // unix ms, matching the schema's INTEGER created_at/updated_at.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- pool-taking helpers (the real SQL; unit-tested below) --------------------

async fn list_cycles_db(pool: &SqlitePool) -> Result<Vec<Cycle>, sqlx::Error> {
    sqlx::query_as::<_, Cycle>(
        "SELECT id, name, product_desc, product_id, guide, guide_id, prev_cycle_id, created_at, updated_at \
         FROM cycle ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await
}

async fn get_cycle_db(pool: &SqlitePool, id: &str) -> Result<Cycle, sqlx::Error> {
    sqlx::query_as::<_, Cycle>(
        "SELECT id, name, product_desc, product_id, guide, guide_id, prev_cycle_id, created_at, updated_at \
         FROM cycle WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

async fn create_cycle_db(pool: &SqlitePool, name: &str) -> Result<Cycle, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let ts = now_ms();
    sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(name)
        .bind(ts)
        .bind(ts)
        .execute(pool)
        .await?;
    get_cycle_db(pool, &id).await
}

async fn update_cycle_db(pool: &SqlitePool, req: &UpdateCycle) -> Result<Cycle, sqlx::Error> {
    // Normalize empty FK ids (UI "none") to NULL so the FKs stay valid.
    let prev = req.prev_cycle_id.as_deref().filter(|s| !s.is_empty());
    let guide_id = req.guide_id.as_deref().filter(|s| !s.is_empty());
    let product_id = req.product_id.as_deref().filter(|s| !s.is_empty());
    let ts = now_ms();
    sqlx::query(
        "UPDATE cycle SET name = ?, product_desc = ?, product_id = ?, guide = ?, guide_id = ?, \
         prev_cycle_id = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&req.name)
    .bind(&req.product_desc)
    .bind(product_id)
    .bind(&req.guide)
    .bind(guide_id)
    .bind(prev)
    .bind(ts)
    .bind(&req.id)
    .execute(pool)
    .await?;
    get_cycle_db(pool, &req.id).await
}

async fn delete_cycle_db(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM cycle WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// --- Tauri commands (thin wrappers; stringify errors for the frontend) --------

#[tauri::command]
pub async fn list_cycles(db: tauri::State<'_, Db>) -> Result<Vec<Cycle>, String> {
    list_cycles_db(&db.pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_cycle(db: tauri::State<'_, Db>, id: String) -> Result<Cycle, String> {
    get_cycle_db(&db.pool, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_cycle(db: tauri::State<'_, Db>, req: CreateCycle) -> Result<Cycle, String> {
    create_cycle_db(&db.pool, &req.name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_cycle(db: tauri::State<'_, Db>, req: UpdateCycle) -> Result<Cycle, String> {
    update_cycle_db(&db.pool, &req)
        .await
        .map_err(|e| e.to_string())
}

// Delete cascades to interviews via the schema's ON DELETE CASCADE.
#[tauri::command]
pub async fn delete_cycle(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    delete_cycle_db(&db.pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build an in-memory pool with the real migration applied.
    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // create → edit Overview fields → reload: rows persist with the saved values.
    // This is the Milestone 2 verify path, exercised against the real schema.
    #[tokio::test]
    async fn create_update_reload_roundtrip() {
        let pool = test_pool().await;

        // Empty list at start.
        assert_eq!(list_cycles_db(&pool).await.unwrap().len(), 0);

        // Create (name only).
        let created = create_cycle_db(&pool, "Onboarding wave 3").await.unwrap();
        assert_eq!(created.name, "Onboarding wave 3");
        assert_eq!(created.product_desc, ""); // schema default
        assert_eq!(created.guide, "");
        assert!(created.prev_cycle_id.is_none());

        // A second cycle to use as prev_cycle_id.
        let prev = create_cycle_db(&pool, "Wave 2").await.unwrap();

        // Edit the Overview fields + point at the previous cycle.
        let updated = update_cycle_db(
            &pool,
            &UpdateCycle {
                id: created.id.clone(),
                name: "Onboarding wave 3 (edited)".into(),
                product_desc: "A checkout product.".into(),
                guide: "Goals:\n- G1 drop-off".into(),
                guide_id: None,
                product_id: None,
                prev_cycle_id: Some(prev.id.clone()),
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "Onboarding wave 3 (edited)");
        assert_eq!(updated.product_desc, "A checkout product.");
        assert_eq!(updated.prev_cycle_id.as_deref(), Some(prev.id.as_str()));
        assert!(updated.updated_at >= created.updated_at);

        // Reload by id: persisted values come back.
        let reloaded = get_cycle_db(&pool, &created.id).await.unwrap();
        assert_eq!(reloaded.guide, "Goals:\n- G1 drop-off");
        assert_eq!(reloaded.prev_cycle_id.as_deref(), Some(prev.id.as_str()));

        // List has both, newest first.
        let all = list_cycles_db(&pool).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    // Empty prev_cycle_id from the UI's "none" Select normalizes to NULL.
    #[tokio::test]
    async fn empty_prev_cycle_becomes_null() {
        let pool = test_pool().await;
        let c = create_cycle_db(&pool, "Solo").await.unwrap();
        let updated = update_cycle_db(
            &pool,
            &UpdateCycle {
                id: c.id.clone(),
                name: "Solo".into(),
                product_desc: "".into(),
                guide: "".into(),
                guide_id: None,
                product_id: None,
                prev_cycle_id: Some(String::new()), // empty → NULL
            },
        )
        .await
        .unwrap();
        assert!(updated.prev_cycle_id.is_none());
    }

    // M10a: the Overview guide picker writes cycle.guide_id; it round-trips, and an empty
    // string from the UI's "no guide" choice normalizes to NULL.
    #[tokio::test]
    async fn guide_id_links_and_empty_normalizes_to_null() {
        let pool = test_pool().await;
        // A library guide to link to.
        let gid = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO guide (id, name, content_md, goals_json, created_at, updated_at) VALUES (?, 'Lib', 'Goals:\n- A', '[]', ?, ?)")
            .bind(&gid).bind(ts).bind(ts).execute(&pool).await.unwrap();

        let c = create_cycle_db(&pool, "Linked").await.unwrap();
        assert!(c.guide_id.is_none(), "fresh cycle has no linked guide");

        // Link it.
        let linked = update_cycle_db(
            &pool,
            &UpdateCycle {
                id: c.id.clone(),
                name: "Linked".into(),
                product_desc: "".into(),
                guide: "".into(),
                guide_id: Some(gid.clone()),
                product_id: None,
                prev_cycle_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(linked.guide_id.as_deref(), Some(gid.as_str()));

        // Unlink via an empty string (UI "no guide") → NULL.
        let unlinked = update_cycle_db(
            &pool,
            &UpdateCycle {
                id: c.id.clone(),
                name: "Linked".into(),
                product_desc: "".into(),
                guide: "".into(),
                guide_id: Some(String::new()),
                product_id: None,
                prev_cycle_id: None,
            },
        )
        .await
        .unwrap();
        assert!(unlinked.guide_id.is_none(), "empty guide_id → NULL");
    }

    // Products library: the Overview product picker writes cycle.product_id; it round-trips,
    // and an empty string from the UI's "no product" choice normalizes to NULL.
    #[tokio::test]
    async fn product_id_links_and_empty_normalizes_to_null() {
        let pool = test_pool().await;
        // A library product to link to.
        let pid = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO product (id, name, content_md, created_at, updated_at) VALUES (?, 'Lib product', 'Acme context', ?, ?)")
            .bind(&pid).bind(ts).bind(ts).execute(&pool).await.unwrap();

        let c = create_cycle_db(&pool, "Linked").await.unwrap();
        assert!(c.product_id.is_none(), "fresh cycle has no linked product");

        // Link it.
        let linked = update_cycle_db(
            &pool,
            &UpdateCycle {
                id: c.id.clone(),
                name: "Linked".into(),
                product_desc: "".into(),
                guide: "".into(),
                guide_id: None,
                product_id: Some(pid.clone()),
                prev_cycle_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(linked.product_id.as_deref(), Some(pid.as_str()));

        // Unlink via an empty string (UI "no product") → NULL.
        let unlinked = update_cycle_db(
            &pool,
            &UpdateCycle {
                id: c.id.clone(),
                name: "Linked".into(),
                product_desc: "".into(),
                guide: "".into(),
                guide_id: None,
                product_id: Some(String::new()),
                prev_cycle_id: None,
            },
        )
        .await
        .unwrap();
        assert!(unlinked.product_id.is_none(), "empty product_id → NULL");
    }
}
