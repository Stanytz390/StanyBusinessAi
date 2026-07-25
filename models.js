import mongoose from 'mongoose';

const OwnerSchema = new mongoose.Schema({
    ownerName: { type: String, required: true },
    ownerNumber: { type: String, required: true, unique: true }, // Mfano: 255712345678
    
    // Mipangilio binafsi ya biashara yake
    businessName: { type: String, default: "Stany Max Hub Business" },
    welcomeMessage: { type: String, default: "Karibu kwenye kituo chetu cha huduma!" },
    
    // Orodha ya huduma za huyu mtu pekee
    services: [
        {
            keyword: { type: String, required: true }, // Mfano: "1"
            name: { type: String, required: true },    // Mfano: "Graphics Design"
            description: { type: String, required: true },
            price: { type: String, required: true },
            imageUrl: { type: String, default: "" }
        }
    ]
});

export const Owner = mongoose.model('Owner', OwnerSchema);
