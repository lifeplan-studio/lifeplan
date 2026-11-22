const SUPABASE_URL = "https://ylvbfsbbhqwwuuimgozp.supabase.co";
const SUPABASE_KEY = "sb_publishable_huDwsyEnaKZacKEHb-o9rg_gLqw4oK0";

const supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
);
console.log("Supabase подключён:", !!supabaseClient);