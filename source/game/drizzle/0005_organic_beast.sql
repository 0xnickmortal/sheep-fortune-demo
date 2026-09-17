CREATE TABLE `vault_controls` (
	`asset` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`burning` text
);
