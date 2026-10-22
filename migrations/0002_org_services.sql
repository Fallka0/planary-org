-- The Planary services an organisation uses, as a JSON array of 'tournament' and 'wishlist'.
-- Existing organisations were made for Tournament. Turning a service off hides it; nothing is deleted.
ALTER TABLE organisations ADD COLUMN services TEXT NOT NULL DEFAULT '["tournament"]';
