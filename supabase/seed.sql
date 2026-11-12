-- =============================================================================
-- DigiAnchorZ Voice SaaS · SQL Founder Bootstrap Snippet
-- Assigns your registered Supabase Auth user (pheonixtamil2025@gmail.com)
-- as owner of the DigiAnchorZ workspace and seeds the synthetic test lead.
-- =============================================================================

select public.bootstrap_digianchorz_founder(
  '30f1dac0-686d-47f4-94f3-acd3d55cc0ed'::uuid,
  'pheonixtamil2025@gmail.com'
);
