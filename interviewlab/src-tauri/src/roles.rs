// Role library CRUD (Milestone 10a, feature-roles-and-guides.md §1).
//
// A flat, user-managed list of roles (no is_interviewer flag — per feedback; the list is
// seeded with a default `Interviewer` role in migration 0002). Replaces the editor's old
// fixed enum: the speaker→role picker now pulls from this library and chips use each
// role's color.
//
// Conventions mirror cycle.rs / interview.rs exactly: a typed struct maps the `role`
// table (migrations/0002_roles_guides.sql) 1:1, all SQL is parameterized, and each
// #[tauri::command] is a thin wrapper over a pool-taking helper (`*_db`) so the row logic
// is unit-testable against a real sqlx SQLite pool.

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::Db;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// A full role row — field names/types match the `role` table 1:1.
#[derive(Serialize, FromRow, Clone, Debug)]
pub struct Role {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

// Create: a name (+ optional color/sort). The id is server-generated.
#[derive(Deserialize)]
pub struct CreateRole {
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub sort: Option<i64>,
}

// Update: id selects the row; name/color/sort overwrite.
#[derive(Deserialize)]
pub struct UpdateRole {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort: i64,
}

// --- pool-taking helpers (the real SQL; unit-tested below) --------------------

async fn list_roles_db(pool: &SqlitePool) -> Result<Vec<Role>, sqlx::Error> {
    sqlx::query_as::<_, Role>(
        "SELECT id, name, color, sort, created_at, updated_at FROM role ORDER BY sort, created_at",
    )
    .fetch_all(pool)
    .await
}

async fn get_role_db(pool: &SqlitePool, id: &str) -> Result<Role, sqlx::Error> {
    sqlx::query_as::<_, Role>(
        "SELECT id, name, color, sort, created_at, updated_at FROM role WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

async fn create_role_db(pool: &SqlitePool, req: &CreateRole) -> Result<Role, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let ts = now_ms();
    // Default sort to "append to the end" when the caller doesn't specify one.
    let sort = match req.sort {
        Some(s) => s,
        None => {
            let max: Option<i64> = sqlx::query_scalar("SELECT MAX(sort) FROM role")
                .fetch_one(pool)
                .await?;
            max.unwrap_or(-1) + 1
        }
    };
    sqlx::query(
        "INSERT INTO role (id, name, color, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(req.name.trim())
    .bind(&req.color)
    .bind(sort)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await?;
    get_role_db(pool, &id).await
}

async fn update_role_db(pool: &SqlitePool, req: &UpdateRole) -> Result<Role, sqlx::Error> {
    sqlx::query("UPDATE role SET name = ?, color = ?, sort = ?, updated_at = ? WHERE id = ?")
        .bind(req.name.trim())
        .bind(&req.color)
        .bind(req.sort)
        .bind(now_ms())
        .bind(&req.id)
        .execute(pool)
        .await?;
    get_role_db(pool, &req.id).await
}

// How many participants currently reference this role (guards deletion of a role in use).
async fn role_usage_db(pool: &SqlitePool, id: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM participant WHERE role_id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
}

async fn delete_role_db(pool: &SqlitePool, id: &str) -> Result<(), String> {
    // Guard: refuse to delete a role still bound to participants (would orphan their role).
    let used = role_usage_db(pool, id).await.map_err(|e| e.to_string())?;
    if used > 0 {
        return Err(format!(
            "This role is used by {used} participant{} — reassign them first.",
            if used == 1 { "" } else { "s" }
        ));
    }
    sqlx::query("DELETE FROM role WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// --- Tauri commands (thin wrappers; stringify errors for the frontend) --------

#[tauri::command]
pub async fn list_roles(db: tauri::State<'_, Db>) -> Result<Vec<Role>, String> {
    list_roles_db(&db.pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_role(db: tauri::State<'_, Db>, req: CreateRole) -> Result<Role, String> {
    create_role_db(&db.pool, &req).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_role(db: tauri::State<'_, Db>, req: UpdateRole) -> Result<Role, String> {
    update_role_db(&db.pool, &req).await.map_err(|e| e.to_string())
}

// Delete a role; guarded against deleting one still in use (returns an explanatory error).
#[tauri::command]
pub async fn delete_role(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    delete_role_db(&db.pool, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // The migration seeds the four legacy roles, Interviewer first (sort 0).
    #[tokio::test]
    async fn migration_seeds_default_roles() {
        let pool = test_pool().await;
        let roles = list_roles_db(&pool).await.unwrap();
        assert_eq!(roles.len(), 4);
        assert_eq!(roles[0].id, "interviewer");
        assert_eq!(roles[0].name, "Interviewer");
        assert_eq!(roles[0].sort, 0);
        // Seeded ids equal the old enum text (so participant.role_id backfills by match).
        let ids: Vec<&str> = roles.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["interviewer", "respondent", "observer", "other"]);
        // Colors are populated from the design tokens.
        assert!(roles.iter().all(|r| r.color.starts_with('#')));
    }

    // create → update → reload roundtrip; new roles append after the seeds.
    #[tokio::test]
    async fn create_update_reload() {
        let pool = test_pool().await;
        let created = create_role_db(
            &pool,
            &CreateRole { name: "Дизайнер".into(), color: "#c08bd6".into(), sort: None },
        )
        .await
        .unwrap();
        assert_eq!(created.name, "Дизайнер");
        assert_eq!(created.sort, 4, "appends after the 4 seeded roles");

        let updated = update_role_db(
            &pool,
            &UpdateRole {
                id: created.id.clone(),
                name: "Дизайнер (UX)".into(),
                color: "#a07bd6".into(),
                sort: 9,
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "Дизайнер (UX)");
        assert_eq!(updated.color, "#a07bd6");
        assert_eq!(updated.sort, 9);

        let all = list_roles_db(&pool).await.unwrap();
        assert_eq!(all.len(), 5);
    }

    // delete is guarded against a role still bound to a participant.
    #[tokio::test]
    async fn delete_guarded_when_in_use() {
        let pool = test_pool().await;
        // Seed a cycle + interview + a participant bound to the seeded Respondent role.
        let cycle = Uuid::new_v4().to_string();
        let iv = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)")
            .bind(&cycle).bind(ts).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'iv', 'new', ?, ?)")
            .bind(&iv).bind(&cycle).bind(ts).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO participant (id, interview_id, display_name, role, role_id, speaker_label) VALUES (?, ?, 'P', 'respondent', 'respondent', 'S2')")
            .bind(Uuid::new_v4().to_string()).bind(&iv).execute(&pool).await.unwrap();

        // Deleting the in-use role is refused.
        let err = delete_role_db(&pool, "respondent").await.unwrap_err();
        assert!(err.contains("used by 1 participant"), "got: {err}");
        assert_eq!(list_roles_db(&pool).await.unwrap().len(), 4, "role not deleted");

        // An unused role deletes fine.
        delete_role_db(&pool, "observer").await.unwrap();
        assert_eq!(list_roles_db(&pool).await.unwrap().len(), 3);
    }
}
