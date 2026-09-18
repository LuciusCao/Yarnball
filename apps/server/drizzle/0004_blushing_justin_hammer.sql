CREATE TABLE `trip_access_links` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`token` text NOT NULL,
	`role` text NOT NULL,
	`label` text,
	`display_name` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_access_links_token_uq` ON `trip_access_links` (`token`);--> statement-breakpoint
CREATE INDEX `trip_access_links_trip_idx` ON `trip_access_links` (`trip_id`);--> statement-breakpoint
ALTER TABLE `settings` ADD `owner_token_hash` text;--> statement-breakpoint
-- 存量 shareToken 回填（issue #16，手写数据迁移：drizzle-kit generate 只出 DDL，同 0002 先例）：
-- 每条 trip 的现有 share_token 生成一条 role=viewer 访问链接，token 沿用原值——已发出的只读链接不失效。
-- 权威数据自此迁到 trip_access_links 表（含吊销态），trips.share_token 保留为兼容镜像。
-- 幂等：NOT EXISTS 防重跑（journal 已保证 exactly-once，这里再兜一层）；
-- share_token 列 notNull，空串判断是防御旧库异常数据。
INSERT INTO `trip_access_links` (`id`, `trip_id`, `token`, `role`, `label`, `created_at`)
SELECT lower(hex(randomblob(16))), `t`.`id`, `t`.`share_token`, 'viewer', '只读分享',
       (cast((julianday('now') - 2440587.5)*86400000 as integer))
FROM `trips` `t`
WHERE `t`.`share_token` IS NOT NULL
  AND `t`.`share_token` <> ''
  AND NOT EXISTS (
    SELECT 1 FROM `trip_access_links` `l` WHERE `l`.`token` = `t`.`share_token`
  );