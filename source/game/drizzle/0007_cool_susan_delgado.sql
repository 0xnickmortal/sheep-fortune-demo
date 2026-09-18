CREATE TABLE `pending_deposits` (
	`asset` text NOT NULL,
	`tx_hash` text NOT NULL,
	`owner` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`asset`, `tx_hash`)
);
--> statement-breakpoint
CREATE INDEX `pending_deposit_status` ON `pending_deposits` (`asset`,`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `pool_income` ADD `funded_credited` text DEFAULT '0' NOT NULL;