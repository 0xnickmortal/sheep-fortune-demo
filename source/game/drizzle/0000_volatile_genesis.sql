CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet` text,
	`asset` text NOT NULL,
	`available` text NOT NULL,
	`rewards` text NOT NULL,
	`locked` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`last_play` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cas_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	CONSTRAINT "cas_guard_ok" CHECK("cas_guards"."ok"=1)
);
--> statement-breakpoint
CREATE TABLE `challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`message` text NOT NULL,
	`domain` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deposits` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`tx_hash` text NOT NULL,
	`block_hash` text NOT NULL,
	`block_number` integer NOT NULL,
	`amount` text NOT NULL,
	`asset` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deposit_asset_tx` ON `deposits` (`asset`,`tx_hash`);--> statement-breakpoint
CREATE INDEX `deposits_owner_time` ON `deposits` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`asset` text NOT NULL,
	`debit` text NOT NULL,
	`credit` text NOT NULL,
	`amount` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_operation` ON `ledger` (`operation`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`kind` text NOT NULL,
	`response` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_owner_key` ON `operations` (`owner`,`request_key`);--> statement-breakpoint
CREATE TABLE `rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`operation` text NOT NULL,
	`bet` text NOT NULL,
	`gross` text NOT NULL,
	`fee` text NOT NULL,
	`net` text NOT NULL,
	`burn` text NOT NULL,
	`score` integer NOT NULL,
	`sequence` text NOT NULL,
	`rules_version` text NOT NULL,
	`rules_snapshot` text NOT NULL,
	`claimed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rounds_owner_time` ON `rounds` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `treasuries` (
	`asset` text PRIMARY KEY NOT NULL,
	`available` text NOT NULL,
	`burned` text NOT NULL,
	`fees` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `withdrawals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`asset` text NOT NULL,
	`amount` text NOT NULL,
	`recipient` text NOT NULL,
	`status` text NOT NULL,
	`tx_hash` text,
	`raw_tx` text,
	`sender_nonce` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `withdrawals_tx` ON `withdrawals` (`tx_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `withdrawals_sender_nonce` ON `withdrawals` (`sender_nonce`);--> statement-breakpoint
CREATE INDEX `withdrawals_owner_time` ON `withdrawals` (`owner`,`created_at`);