// Supabase configuration - copy this file to supabase_config.js and enter your credentials
const SUPABASE_URL = "YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

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
