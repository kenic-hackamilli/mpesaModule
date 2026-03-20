import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

type SupabaseDatabase = {
  public: {
    Tables: {
      domain_bookings: {
        Row: {
          id: string | null;
          user_id: string | null;
          full_name: string | null;
          phone: string | null;
          email: string | null;
          domain_name: string | null;
          mpesa_transaction_id: string | null;
          payment_status: string | null;
          booked_at: string | null;
          expires_at: string | null;
        };
        Insert: {
          id?: string | null;
          user_id: string;
          full_name: string;
          phone: string;
          email: string;
          domain_name: string;
          mpesa_transaction_id: string;
          payment_status: string;
          booked_at?: string | null;
          expires_at?: string | null;
        };
        Update: Partial<SupabaseDatabase["public"]["Tables"]["domain_bookings"]["Insert"]>;
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string | null;
          user_id: string | null;
          title: string | null;
          message: string | null;
          type: string | null;
        };
        Insert: {
          id?: string | null;
          user_id: string;
          title: string;
          message: string;
          type: string;
        };
        Update: Partial<SupabaseDatabase["public"]["Tables"]["notifications"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

let client: SupabaseClient<SupabaseDatabase> | null = null;

export const getSupabaseAdminClient = () => {
  if (client) return client;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Missing Supabase credentials. Provide SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  client = createClient<SupabaseDatabase>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  return client;
};
