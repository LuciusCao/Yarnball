-- M108：地点状态枚举 locked → joined 数据迁移（手写，drizzle-kit generate 只出 DDL 不含数据 UPDATE）。
-- 幂等：老库把 locked 行转为 joined；新库/已迁移库无 locked 行，WHERE 不命中任何行，重跑安全。
UPDATE `places` SET `status` = 'joined' WHERE `status` = 'locked';
