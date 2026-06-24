// Products library CRUD (ui-backlog.md "Products library"; goal req #2 product context).
//
// A global, reusable library of product descriptions authored in markdown, mirroring the
// guide library (guides.rs §2). Each cycle references a product (cycle.product_id), and the
// product's content_md is fed into the pipeline as PRODUCT CONTEXT — the ASR initial_prompt
// (so brand/product terms transcribe correctly), the cleanup prompt (so terms normalize),
// and the synthesis prompt. The inline `cycle.product_desc` column is kept for back-compat;
// effective_product_db (synthesis.rs) prefers the linked product, falling back to inline.
//
// Conventions mirror guides.rs / cycle.rs: a typed struct maps the `product` table 1:1, all
// SQL is parameterized, each #[tauri::command] is a thin wrapper over a testable `*_db`
// helper. ponytail: a product is plain markdown (no derived goals like a guide), so this is
// guides.rs minus the goals_json caching — strictly simpler.

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

// A full product row — field names/types match the `product` table 1:1.
#[derive(Serialize, FromRow, Clone, Debug)]
pub struct Product {
    pub id: String,
    pub name: String,
    pub content_md: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
pub struct CreateProduct {
    pub name: String,
    #[serde(default)]
    pub content_md: String,
}

#[derive(Deserialize)]
pub struct UpdateProduct {
    pub id: String,
    pub name: String,
    pub content_md: String,
}

// --- pool-taking helpers (the real SQL; unit-tested below) --------------------

async fn list_products_db(pool: &SqlitePool) -> Result<Vec<Product>, sqlx::Error> {
    sqlx::query_as::<_, Product>(
        "SELECT id, name, content_md, created_at, updated_at \
         FROM product ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await
}

async fn get_product_db(pool: &SqlitePool, id: &str) -> Result<Option<Product>, sqlx::Error> {
    sqlx::query_as::<_, Product>(
        "SELECT id, name, content_md, created_at, updated_at FROM product WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

async fn create_product_db(pool: &SqlitePool, req: &CreateProduct) -> Result<Product, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let ts = now_ms();
    sqlx::query(
        "INSERT INTO product (id, name, content_md, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(req.name.trim())
    .bind(&req.content_md)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await?;
    get_product_db(pool, &id)
        .await
        .map(|p| p.expect("just inserted"))
}

async fn update_product_db(pool: &SqlitePool, req: &UpdateProduct) -> Result<Product, sqlx::Error> {
    sqlx::query("UPDATE product SET name = ?, content_md = ?, updated_at = ? WHERE id = ?")
        .bind(req.name.trim())
        .bind(&req.content_md)
        .bind(now_ms())
        .bind(&req.id)
        .execute(pool)
        .await?;
    get_product_db(pool, &req.id)
        .await
        .map(|p| p.expect("just updated"))
}

// Delete a product. Cycles that referenced it keep their inline `product_desc` text (back-
// compat) but their product_id is cleared so they fall back cleanly (the FK is nullable).
async fn delete_product_db(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE cycle SET product_id = NULL WHERE product_id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM product WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// --- Tauri commands (thin wrappers; stringify errors for the frontend) --------

#[tauri::command]
pub async fn list_products(db: tauri::State<'_, Db>) -> Result<Vec<Product>, String> {
    list_products_db(&db.pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_product(db: tauri::State<'_, Db>, id: String) -> Result<Option<Product>, String> {
    get_product_db(&db.pool, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_product(
    db: tauri::State<'_, Db>,
    req: CreateProduct,
) -> Result<Product, String> {
    create_product_db(&db.pool, &req)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_product(
    db: tauri::State<'_, Db>,
    req: UpdateProduct,
) -> Result<Product, String> {
    update_product_db(&db.pool, &req)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_product(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    delete_product_db(&db.pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // create → get/list roundtrip; update overwrites; the row persists.
    #[tokio::test]
    async fn create_update_list_roundtrips() {
        let pool = test_pool().await;
        assert_eq!(list_products_db(&pool).await.unwrap().len(), 0);

        let p = create_product_db(
            &pool,
            &CreateProduct {
                name: "  Acme Analytics  ".into(),
                content_md: "# Acme\n\nSelf-serve analytics. The **activation** milestone is the first funnel.".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(p.name, "Acme Analytics", "name trimmed on insert");
        assert!(p.content_md.contains("activation"));

        let fetched = get_product_db(&pool, &p.id).await.unwrap().unwrap();
        assert_eq!(fetched.id, p.id);

        let updated = update_product_db(
            &pool,
            &UpdateProduct {
                id: p.id.clone(),
                name: "Acme v2".into(),
                content_md: "Updated context.".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "Acme v2");
        assert_eq!(updated.content_md, "Updated context.");
        assert!(updated.updated_at >= p.updated_at);

        let listed = list_products_db(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].content_md, "Updated context.");
    }

    // delete clears any cycle's product_id (keeps the inline product_desc text for back-compat).
    #[tokio::test]
    async fn delete_unlinks_cycle_keeps_inline() {
        let pool = test_pool().await;
        let p = create_product_db(
            &pool,
            &CreateProduct { name: "P".into(), content_md: "ctx".into() },
        )
        .await
        .unwrap();

        let cycle = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, product_desc, product_id, created_at, updated_at) VALUES (?, 'c', 'inline product', ?, ?, ?)")
            .bind(&cycle).bind(&p.id).bind(ts).bind(ts).execute(&pool).await.unwrap();

        delete_product_db(&pool, &p.id).await.unwrap();
        let (product_id, inline): (Option<String>, String) =
            sqlx::query_as("SELECT product_id, product_desc FROM cycle WHERE id = ?")
                .bind(&cycle)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(product_id.is_none(), "product_id cleared on delete");
        assert_eq!(inline, "inline product", "inline product_desc preserved for back-compat");
        assert_eq!(list_products_db(&pool).await.unwrap().len(), 0);
    }

    // The 0005 data-migration: a pre-existing cycle with inline product_desc text gets a
    // product row (name "<cycle> — product", content = the text) + its product_id set; an
    // empty-product cycle is left untouched.
    #[tokio::test]
    async fn data_migration_lifts_product_desc_into_products() {
        // Apply 0001..0004 first (raw_sql runs the multi-statement files), seed legacy-shaped
        // rows with inline product_desc, THEN apply 0005 to exercise the backfill exactly as
        // it runs over a pre-existing DB.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        for f in [
            include_str!("../migrations/0001_init.sql"),
            include_str!("../migrations/0002_roles_guides.sql"),
            include_str!("../migrations/0003_synthesis_artifacts.sql"),
            include_str!("../migrations/0004_chat.sql"),
        ] {
            sqlx::raw_sql(f).execute(&pool).await.unwrap();
        }

        let ts = 1_700_000_000_000i64;
        // Cycle A: has inline product_desc → should get a migrated product + product_id.
        let cyc_a = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, product_desc, created_at, updated_at) VALUES (?, 'Wave A', 'Acme Analytics — funnels + retention.', ?, ?)")
            .bind(&cyc_a).bind(ts).bind(ts).execute(&pool).await.unwrap();
        // Cycle B: empty product_desc → should be left alone.
        let cyc_b = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, product_desc, created_at, updated_at) VALUES (?, 'Wave B', '', ?, ?)")
            .bind(&cyc_b).bind(ts).bind(ts).execute(&pool).await.unwrap();

        // Now apply 0005 (the migration under test) over this legacy state.
        let mig_sql = include_str!("../migrations/0005_products.sql");
        sqlx::raw_sql(mig_sql).execute(&pool).await.unwrap();

        // Cycle A got a migrated product + product_id; the product carries the inline text.
        let (a_product_id,): (Option<String>,) =
            sqlx::query_as("SELECT product_id FROM cycle WHERE id = ?")
                .bind(&cyc_a)
                .fetch_one(&pool)
                .await
                .unwrap();
        let a_product_id = a_product_id.expect("cycle A linked to a migrated product");
        let (pname, pcontent): (String, String) =
            sqlx::query_as("SELECT name, content_md FROM product WHERE id = ?")
                .bind(&a_product_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(pname, "Wave A — product");
        assert!(pcontent.contains("Acme Analytics"));

        // Cycle B (empty product) was left untouched.
        let (b_product_id,): (Option<String>,) =
            sqlx::query_as("SELECT product_id FROM cycle WHERE id = ?")
                .bind(&cyc_b)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(b_product_id.is_none(), "empty-product cycle gets no product row");
        let product_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM product")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(product_count, 1, "only the non-empty cycle yields a product");
    }
}
