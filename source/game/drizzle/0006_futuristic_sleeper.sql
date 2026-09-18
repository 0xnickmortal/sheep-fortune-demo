CREATE TABLE `pool_income` (
	`asset` text NOT NULL,
	`vault` text NOT NULL,
	`credited` text DEFAULT '0' NOT NULL,
	`block_number` integer DEFAULT 0 NOT NULL,
	`block_hash` text,
	`revision` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`asset`, `vault`)
);
