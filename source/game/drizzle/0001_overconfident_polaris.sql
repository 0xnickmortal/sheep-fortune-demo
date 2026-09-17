ALTER TABLE `withdrawals` ADD `fee` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `withdrawals` ADD `fee_bps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `withdrawals` ADD `fee_version` text DEFAULT 'legacy-no-fee-v1' NOT NULL;