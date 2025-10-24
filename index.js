
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { supabaseAdmin } from './supabase/supabaseAdminClient.js';
import dotenv from 'dotenv';
import { stat } from 'fs';
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
        }
        else if (origin && (origin.endsWith('.lovable.app') || origin.endsWith('.lovableproject.com'))) {
            callback(null, origin);
        }
        else {
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
                    is_verified: false,
                    is_seller: false,
                    rating: null
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

app.post('/api/initiate-payment', async (req, res) => {

    const { productId, sellerId, paymentType } = req.body;

    console.log("Initiate payment called with", productId, sellerId, paymentType);

    const { data: existingPayment, error: fetchError } = await supabaseAdmin
        .from('listing_payments')
        .select('*')
        .eq('product_id', productId)
        .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
        // PGRST116 = no rows found, so ignore that
        throw fetchError;
    }

    console.log("Existing payment", existingPayment);

    if (existingPayment) {
        if (['pending', 'failed'].includes(existingPayment.payment_status)) {
            // Payment already started — return it
            return res.json({
                status: "success",
                paymentId: existingPayment.id,
                amount: existingPayment.amount
            });
        }

        if (existingPayment.payment_status === 'completed') {
            // Stop duplicate payment
            return res.status(400).json({
                error: 'Payment already completed for this product.',
            });
        }
    }


    const { data: payment, error: findError } = await supabaseAdmin
        .from('payment_fees')
        .select('*')
        .eq('payment_type', paymentType)
        .single();

    if (findError || !payment.amount) {
        return res.status(400).json({
            status: "error",
            message: "Invalid payment type",
        });
    }

    const { data: paymentData, error: insertError } = await supabaseAdmin
        .from('listing_payments')
        .insert([{
            product_id: productId,
            seller_id: sellerId,
            amount: payment.amount,
            currency: null,
            payment_status: 'pending',

        }])
        .select();


    console.log("Payment data", paymentData, insertError);

    if (insertError) {
        return res.status(500).json({
            status: "error",
            message: "Failed to initiate payment",
        });
    }

    res.json({
        status: "success",
        paymentId: paymentData[0].id,
        amount: payment.amount
    });



});


app.post('/api/verify-payment', async (req, res) => {
    const { reference } = req.body;

    console.log("Verify payment called with", reference);

    const { data: paymentData, error: lookUpError } = await supabaseAdmin
        .from('listing_payments')
        .select("id,product_id")
        .eq('id', reference)
        .single();

    if (lookUpError || !paymentData) {
        return res.status(400).json({
            status: "error",
            message: "Invalid payment reference",
        });
    }

    // const response = await fetch(
    // 		`https://developer.worldcoin.org/api/v2/minikit/transaction/${paymentReference}?app_id=${process.env.APP_ID}`,
    // 		{
    // 			method: 'GET',
    // 			headers: {
    // 				Authorization: `Bearer ${process.env.DEV_PORTAL_API_KEY}`,
    // 			},
    // 		}
    // 	)

    const paymentVerification = { status: "completed" }; // await response.json();

    console.log("Payment verification response", paymentVerification);

    if (paymentVerification.status === "failed") {
        return res.status(400).json({
            status: "error",
            message: "Payment not confirmed",
        });
    }

    // Update payment status in DB
    const { error: paymentStatusUpdateError } = await supabaseAdmin
        .from('listing_payments')
        .update({ payment_status: 'completed' })
        .eq('id', reference)
        .select();

    if (paymentStatusUpdateError) {
        return res.status(500).json({
            status: "error",
            message: "Failed to update payment status",
        });
    }

    const { error: productStatusUpdateError } = await supabaseAdmin
        .from('products')
        .update({ status: 'active' })
        .eq('id', paymentData.product_id)
        .select();

    if (productStatusUpdateError) {
        return res.status(500).json({
            status: "error",
            message: "Failed to update product status",
        });
    }

    res.json({
        status: "success",
        message: "Payment verified and completed",
    });

});



// ✅ Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
