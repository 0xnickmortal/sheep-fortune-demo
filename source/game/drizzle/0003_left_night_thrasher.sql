CREATE TABLE `wallet_policies` (
	`asset` text NOT NULL,
	`wallet` text NOT NULL,
	`weights` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`asset`, `wallet`),
	CONSTRAINT "wallet_policy_enabled" CHECK("wallet_policies"."enabled" in (0,1)),
	CONSTRAINT "wallet_policy_revision" CHECK("wallet_policies"."revision">0)
);
