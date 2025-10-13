
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { supabaseAdmin } from './supabase/supabaseAdminClient.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(cookieParser());


const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map(o => o.trim()) || [];


// ✅ Setup CORS
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, origin);
        } else {
            callback(new Error("CORS not allowed for this origin"));
        }
    },
    credentials: true,
}));

// ✅ Sample route — generate nonce and set cookie
app.get('/api/nonce', (req, res) => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    console.log(`Generated nonce: ${nonce} for origin: ${req.get('origin')}`);

    res.cookie('siwe', nonce, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
    });

    res.json({ nonce });
});

app.post('/api/signin', async (req, res) => {
    try {
        const { walletAddress, username, profilePictureUrl, nonce } = await req.body;

        const cookieNonce = req.cookies.siwe;
        console.log("cookie nonce", cookieNonce, "body nonce", nonce);
        // if (nonce != cookieNonce) {
        //     return res.status(400).json({
        //         status: "error",
        //         isValid: false,
        //         message: "Invalid nonce",
        //     });
        // }

        // 1. Check if user exists
        const { data: existingUser, error: findError } = await supabaseAdmin
            .from('user_profiles')
            .select('*')
            .eq('wallet_address', walletAddress)
            .single();


        let userId;

        console.log("existing user", existingUser, findError);



            const syntheticEmail = `${walletAddress}@worldcoin.local`;

            if (!existingUser) {
                // 2. Create new Supabase user

                const { data: newUser, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
                    email: syntheticEmail,
                    email_confirm: true,
                });

                if (createUserError || !newUser?.user?.id) {
                    throw new Error('Failed to create Supabase user');
                }
                userId = newUser.user.id;

                // Insert into user_profiles
                const { error: insertError } = await supabaseAdmin
                    .from('user_profiles')
                    .insert([{
                        id: userId,
                        wallet_address: walletAddress,
                        username,
                        profile_picture_url: profilePictureUrl,
                        nullifier_hash: "random",
                        verification_level: 'orb',
                        is_verified: false,
                        is_seller: false,
                        rating: null,
                        //   created_time: new Date().toISOString(),
                        //   updated_time: new Date().toISOString(),
                    }]);

                if (insertError) {
                    console.log("error inserting user", insertError);
                    throw new Error('Failed to insert user profile');
                }
            } else {
                userId = existingUser.id;
            }


            const { data: generateData } = await supabaseAdmin.auth.admin.generateLink({
                type: 'magiclink',
                email: syntheticEmail,
            });

            const tokenHash = generateData?.properties?.hashed_token;

            if (!tokenHash) throw new Error('Could not obtain token_hash from generateLink response');


            const { data: verifyData, error: verifyErr } = await supabaseAdmin.auth.verifyOtp({
                type: 'email',
                token_hash: tokenHash,
            });
            if (verifyErr) throw verifyErr;


            const access_token = verifyData?.session?.access_token;
            const refresh_token = verifyData?.session?.refresh_token;

            if (!access_token) throw new Error('Failed to obtain access token');

            // 6) return tokens to client
            res.json({
                access_token,
                refresh_token,
                userId
            }, { status: 200 });


    } catch (err) {
        console.error('Error in /api/worldcoin-signin:', err);
        res.json({ error: err.message }, { status: 500 });
    }
});

// ✅ Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
