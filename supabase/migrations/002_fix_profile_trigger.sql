-- Fix for "Database error saving new user"
-- Run this in Supabase SQL Editor

-- Step 1: Make github_username nullable (in case metadata is missing)
ALTER TABLE profiles ALTER COLUMN github_username DROP NOT NULL;

-- Step 2: Update the trigger function to handle all GitHub metadata variations
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    _username TEXT;
    _avatar TEXT;
BEGIN
    -- GitHub OAuth sends metadata in different formats
    -- Try multiple possible field names
    _username := COALESCE(
        NEW.raw_user_meta_data->>'user_name',
        NEW.raw_user_meta_data->>'preferred_username',
        NEW.raw_user_meta_data->>'name',
        NEW.raw_user_meta_data->>'email',
        'user_' || LEFT(NEW.id::text, 8)
    );

    _avatar := COALESCE(
        NEW.raw_user_meta_data->>'avatar_url',
        NEW.raw_user_meta_data->>'picture',
        ''
    );

    INSERT INTO profiles (id, github_username, github_avatar_url)
    VALUES (NEW.id, _username, _avatar)
    ON CONFLICT (id) DO UPDATE SET
        github_username = COALESCE(EXCLUDED.github_username, profiles.github_username),
        github_avatar_url = COALESCE(EXCLUDED.github_avatar_url, profiles.github_avatar_url),
        updated_at = NOW();

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Log error but don't fail the signup
    RAISE WARNING 'Error creating profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ language 'plpgsql' SECURITY DEFINER;

-- Step 3: Ensure the trigger exists and is properly attached
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION handle_new_user();

-- Step 4: Grant necessary permissions
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON profiles TO authenticated;
