-- Add verbose logging support to jobs table
-- Stores detailed processing steps for debugging and optimization

-- Add processing_log column to store detailed logs
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS processing_log JSONB DEFAULT '[]'::jsonb;

-- Add model_info column to store model response metadata (tokens, timing, etc)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS model_info JSONB DEFAULT '{}'::jsonb;

-- Create function to append to processing log
CREATE OR REPLACE FUNCTION append_job_log(
  p_job_id UUID,
  p_message TEXT,
  p_level TEXT DEFAULT 'info',
  p_data JSONB DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE jobs
  SET processing_log = processing_log || jsonb_build_object(
    'timestamp', NOW()::TEXT,
    'level', p_level,
    'message', p_message,
    'data', p_data
  )
  WHERE id = p_job_id;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION append_job_log TO service_role;

COMMENT ON COLUMN jobs.processing_log IS 'Detailed log of processing steps for debugging. Array of {timestamp, level, message, data} objects.';
COMMENT ON COLUMN jobs.model_info IS 'Model response metadata: tokens used, response time, model version, etc.';
