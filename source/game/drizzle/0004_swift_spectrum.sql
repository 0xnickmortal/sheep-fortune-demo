CREATE TABLE `referral_profiles` (
	`owner` text PRIMARY KEY NOT NULL,
	`code` text,
	`parent` text,
	`activated_at` integer,
	`bound_at` integer,
	FOREIGN KEY (`owner`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "referral_not_self" CHECK("referral_profiles"."parent" IS NULL OR "referral_profiles"."parent"<>"referral_profiles"."owner")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_code` ON `referral_profiles` (`code`);--> statement-breakpoint
CREATE INDEX `referral_parent` ON `referral_profiles` (`parent`);--> statement-breakpoint
CREATE TABLE `referral_rewards` (
	`id` text PRIMARY KEY NOT NULL,
	`round` text NOT NULL,
	`player` text NOT NULL,
	`recipient` text NOT NULL,
	`asset` text NOT NULL,
	`level` integer NOT NULL,
	`stake` text NOT NULL,
	`amount` text NOT NULL,
	`policy` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_round_level` ON `referral_rewards` (`round`,`level`);--> statement-breakpoint
CREATE INDEX `referral_recipient_time` ON `referral_rewards` (`recipient`,`created_at`);--> statement-breakpoint
CREATE TABLE `vault_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`asset` text NOT NULL,
	`vault` text NOT NULL,
	`authorization_id` text NOT NULL,
	`payload` text NOT NULL,
	`signature` text NOT NULL,
	`deadline` integer NOT NULL,
	`status` text NOT NULL,
	`tx_hash` text,
	`amount` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_authorizations_authorization_id_unique` ON `vault_authorizations` (`authorization_id`);--> statement-breakpoint
CREATE INDEX `vault_authorization_asset_status` ON `vault_authorizations` (`asset`,`status`);