// Supabase configuration - update with your credentials
const SUPABASE_URL = "https://ojkejucmghtvmiesmsgt.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_VyhUW7-4PsyHqYIZm3cyIg_tgqd1zWq";

let supabaseClient = null;

function initSupabase() {
  if (supabaseClient) return supabaseClient;
  
  if (
    typeof supabase !== "undefined" &&
    supabase.createClient &&
    SUPABASE_URL !== "YOUR_SUPABASE_URL" &&
    SUPABASE_ANON_KEY !== "YOUR_SUPABASE_ANON_KEY"
  ) {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabaseClient;
}

// Initialize immediately on script load if available
initSupabase();
